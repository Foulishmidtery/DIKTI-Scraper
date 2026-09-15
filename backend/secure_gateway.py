"""Short-lived, signed gateway client. Secrets exist only in process memory."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Iterable
from urllib.parse import urlparse

import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from backend.config import settings


class GatewayError(RuntimeError):
    """Sanitized gateway failure safe to show to the local UI."""


@dataclass
class _Session:
    session_id: str
    key: bytearray
    expires_at: int
    access_token: str


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _derive_key(session_key: bytes, purpose: bytes) -> bytes:
    return hmac.new(session_key, b"pddikti-gateway-v3:" + purpose, hashlib.sha256).digest()


def _payload_batches(
    rows: list[dict[str, Any]],
    max_rows: int = 100,
    max_json_bytes: int = 600_000,
) -> Iterable[list[dict[str, Any]]]:
    """Batch berdasarkan ukuran JSON agar detail dosen tetap di bawah limit gateway."""
    batch: list[dict[str, Any]] = []
    batch_bytes = 2
    for row in rows:
        row_bytes = len(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        if row_bytes > max_json_bytes:
            raise GatewayError("Satu profil dosen melebihi batas aman pengiriman gateway.")
        added_bytes = row_bytes + (1 if batch else 0)
        if batch and (len(batch) >= max_rows or batch_bytes + added_bytes > max_json_bytes):
            yield batch
            batch = []
            batch_bytes = 2
            added_bytes = row_bytes
        batch.append(row)
        batch_bytes += added_bytes
    if batch:
        yield batch


class SecureGatewayClient:
    def __init__(self) -> None:
        self._url = settings.gateway_url.rstrip("/")
        self._device_id = f"session-{uuid.uuid4()}"
        self._client_private_key = Ed25519PrivateKey.generate()
        client_public_der = self._client_private_key.public_key().public_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        self._client_public_key = _b64encode(client_public_der)
        self._client_key_thumbprint = _b64encode(hashlib.sha256(client_public_der).digest())
        self._session: _Session | None = None
        self._http = requests.Session()
        self._lock = threading.RLock()
        self._refresh_stop = threading.Event()
        self._refresh_thread: threading.Thread | None = None
        self._validate_url()

    def _validate_url(self) -> None:
        if not self._url:
            return
        parsed = urlparse(self._url)
        local_development = parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}
        if parsed.scheme != "https" and not (settings.allow_insecure_gateway and local_development):
            raise GatewayError("Gateway production wajib menggunakan HTTPS.")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise GatewayError("Alamat gateway tidak valid.")

    @property
    def configured(self) -> bool:
        return bool(self._url)

    @property
    def authenticated(self) -> bool:
        return bool(self._session and self._session.expires_at > int(time.time()))

    def auth_status(self) -> dict[str, Any]:
        return {
            "mode": "secure_gateway",
            "required": True,
            "authenticated": self.authenticated,
            "expires_at": self._session.expires_at if self.authenticated and self._session else None,
        }

    def _json(self, value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

    def _safe_response(self, response: requests.Response) -> dict[str, Any]:
        try:
            body = response.json()
        except ValueError as exc:
            raise GatewayError("Respons gateway tidak valid.") from exc
        if not isinstance(body, dict):
            raise GatewayError("Respons gateway tidak valid.")
        if response.status_code >= 400:
            allowed = {
                "Kode aktivasi tidak valid.",
                "Versi aplikasi tidak didukung.",
                "Terlalu banyak percobaan.",
                "Terlalu banyak permintaan.",
                "Sesi atau signature tidak valid.",
            }
            message = str(body.get("error", ""))
            raise GatewayError(message if message in allowed else "Gateway sementara tidak tersedia.")
        return body

    def activate(self, activation_code: str) -> dict[str, Any]:
        code = str(activation_code or "")
        if len(code) < 8 or len(code) > 128:
            raise GatewayError("Kode aktivasi tidak valid.")
        if not self.configured:
            raise GatewayError("Gateway production belum dikonfigurasi.")
        with self._lock:
            try:
                response = self._http.post(
                    f"{self._url}/api/session",
                    json={
                        "activation_code": code,
                        "device_id": self._device_id,
                        "client_public_key": self._client_public_key,
                        "desktop_version": settings.desktop_version,
                    },
                    timeout=(5, 20),
                )
            except requests.RequestException as exc:
                raise GatewayError("Gateway tidak dapat dihubungi dengan aman.") from exc
            finally:
                code = ""
            body = self._safe_response(response)
            self._replace_session(body)
            self._start_refresh_worker()
            return self.auth_status()

    def _replace_session(self, body: dict[str, Any]) -> None:
        session_id = str(body.get("session_id", ""))
        key_text = str(body.get("session_key", ""))
        access_token = str(body.get("access_token", ""))
        expires_at = int(body.get("expires_at", 0))
        try:
            key = bytearray(_b64decode(key_text))
        except (ValueError, TypeError) as exc:
            raise GatewayError("Respons sesi gateway tidak valid.") from exc
        if (len(session_id) < 40 or len(key) != 32 or expires_at <= int(time.time()) or
                not self._verify_access_token(access_token, session_id, expires_at)):
            for index in range(len(key)):
                key[index] = 0
            raise GatewayError("Respons sesi gateway tidak valid.")
        self._clear_session_memory()
        self._session = _Session(
            session_id=session_id,
            key=key,
            expires_at=expires_at,
            access_token=access_token,
        )

    def _verify_access_token(self, token: str, session_id: str, expires_at: int) -> bool:
        try:
            encoded_header, encoded_payload, encoded_signature = token.split(".")
            header = json.loads(_b64decode(encoded_header))
            claims = json.loads(_b64decode(encoded_payload))
            public_der = _b64decode(settings.gateway_jwt_public_key)
            public_key = serialization.load_der_public_key(public_der)
            if not isinstance(public_key, Ed25519PublicKey):
                return False
            if header != {"alg": "EdDSA", "kid": "gateway-v1", "typ": "JWT"}:
                return False
            confirmation = claims.get("cnf")
            now = int(time.time())
            if (claims.get("iss") != "pddikti-secure-gateway" or
                    claims.get("aud") != "pddikti-desktop" or
                    claims.get("sub") != self._device_id or
                    claims.get("sid") != session_id or
                    claims.get("jti") != session_id or
                    int(claims.get("exp", 0)) != expires_at or
                    int(claims.get("nbf", 0)) > now + 30 or
                    int(claims.get("iat", 0)) > now + 30 or
                    not isinstance(confirmation, dict) or
                    confirmation.get("jkt") != self._client_key_thumbprint or
                    expires_at <= now):
                return False
            public_key.verify(
                _b64decode(encoded_signature),
                f"{encoded_header}.{encoded_payload}".encode("ascii"),
            )
            return True
        except Exception:
            return False

    def _clear_session_memory(self) -> None:
        if self._session:
            for index in range(len(self._session.key)):
                self._session.key[index] = 0
        self._session = None

    def _encrypted_request(
        self,
        action: str,
        payload: dict[str, Any],
    ) -> tuple[dict[str, Any], dict[str, str], tuple[str, str, str]]:
        session = self._session
        if not session:
            raise GatewayError("Aktivasi aplikasi diperlukan.")
        timestamp = str(int(time.time()))
        nonce = secrets.token_urlsafe(24)
        request_id = str(uuid.uuid4())
        aad_values = (timestamp, nonce, request_id)
        aad = "\n".join([
            "pddikti-v3-request", "POST", "/api/gateway", session.session_id,
            self._device_id, *aad_values,
        ]).encode("utf-8")
        iv = secrets.token_bytes(12)
        plaintext = self._json({"action": action, "payload": payload}).encode("utf-8")
        ciphertext = AESGCM(_derive_key(bytes(session.key), b"aes-256-gcm")).encrypt(iv, plaintext, aad)
        body = {"version": 3, "iv": _b64encode(iv), "ciphertext": _b64encode(ciphertext)}
        body_hash = hashlib.sha256(self._json(body).encode("utf-8")).hexdigest()
        canonical = "\n".join([
            "POST", "/api/gateway", session.session_id, self._device_id,
            timestamp, nonce, request_id, body_hash,
        ])
        signature = hmac.new(
            _derive_key(bytes(session.key), b"request-hmac"),
            canonical.encode("utf-8"),
            hashlib.sha256,
        ).digest()
        token_hash = hashlib.sha256(session.access_token.encode("ascii")).hexdigest()
        client_proof = self._client_private_key.sign(
            f"{canonical}\n{token_hash}".encode("utf-8")
        )
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {session.access_token}",
            "X-Session-ID": session.session_id,
            "X-Device-ID": self._device_id,
            "X-Timestamp": timestamp,
            "X-Nonce": nonce,
            "X-Request-ID": request_id,
            "X-Signature": _b64encode(signature),
            "X-Client-Proof": _b64encode(client_proof),
        }
        return body, headers, aad_values

    def _decrypt_response(
        self,
        response: requests.Response,
        session: _Session,
        aad_values: tuple[str, str, str],
    ) -> dict[str, Any]:
        envelope = self._safe_response(response)
        try:
            if (envelope.get("success") is not True or envelope.get("version") != 3 or
                    not isinstance(envelope.get("iv"), str) or
                    not isinstance(envelope.get("ciphertext"), str)):
                raise ValueError("bad_envelope")
            aad = "\n".join([
                "pddikti-v3-response", "POST", "/api/gateway", session.session_id,
                self._device_id, *aad_values,
            ]).encode("utf-8")
            plaintext = AESGCM(_derive_key(bytes(session.key), b"aes-256-gcm")).decrypt(
                _b64decode(str(envelope["iv"])),
                _b64decode(str(envelope["ciphertext"])),
                aad,
            )
            body = json.loads(plaintext)
            if not isinstance(body, dict):
                raise ValueError("bad_body")
            return body
        except Exception as exc:
            raise GatewayError("Respons gateway tidak valid.") from exc

    def _send(self, action: str, payload: dict[str, Any], *, retries: int = 2) -> dict[str, Any]:
        if not self.authenticated:
            self._clear_session_memory()
            raise GatewayError("Sesi berakhir. Aktivasi ulang diperlukan.")
        if action != "refresh_session" and self._session and self._session.expires_at - int(time.time()) < 120:
            self._refresh()
        last_error: Exception | None = None
        for attempt in range(retries + 1):
            session = self._session
            if not session:
                raise GatewayError("Aktivasi aplikasi diperlukan.")
            body, headers, aad_values = self._encrypted_request(action, payload)
            try:
                response = self._http.post(
                    f"{self._url}/api/gateway",
                    data=self._json(body).encode("utf-8"),
                    headers=headers,
                    timeout=(5, 30),
                )
                if response.status_code not in {502, 503, 504} or attempt >= retries:
                    return self._decrypt_response(response, session, aad_values)
            except requests.RequestException as exc:
                last_error = exc
                if attempt >= retries:
                    break
            time.sleep(min(2 ** attempt, 4))
        raise GatewayError("Gateway tidak dapat dihubungi dengan aman.") from last_error

    def request(self, action: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            return self._send(action, payload or {})

    def _refresh(self) -> None:
        body = self._send("refresh_session", {}, retries=0)
        self._replace_session(body)

    def _start_refresh_worker(self) -> None:
        if self._refresh_thread and self._refresh_thread.is_alive():
            return
        self._refresh_stop.clear()

        def worker() -> None:
            while not self._refresh_stop.wait(30):
                with self._lock:
                    if not self._session:
                        return
                    if self._session.expires_at - int(time.time()) < 120:
                        try:
                            self._refresh()
                        except GatewayError:
                            self._clear_session_memory()
                            return

        self._refresh_thread = threading.Thread(target=worker, daemon=True, name="gateway-session-refresh")
        self._refresh_thread.start()

    def close(self) -> None:
        self._refresh_stop.set()
        with self._lock:
            if self.authenticated:
                try:
                    self._send("revoke_session", {}, retries=0)
                except GatewayError:
                    pass
            self._clear_session_memory()
            self._http.close()

    def status(self) -> dict[str, Any]:
        if not self.authenticated:
            return {
                "configured": self.configured,
                "connected": False,
                "message": "Aktivasi sesi diperlukan",
            }
        result = self.request("status")
        return {
            "configured": True,
            "connected": True,
            "message": "Secure gateway terhubung",
            "total_dosen": int(result.get("total_dosen", 0)),
            "total_prodi": int(result.get("total_prodi", 0)),
        }

    def create_run(self, run_id: str, selected_prodi: list[str]) -> None:
        self.request("create_run", {"run_id": run_id, "selected_prodi": selected_prodi})

    def persist(self, run_id: str, profiles: list[dict[str, Any]], prodi: list[dict[str, Any]]) -> dict[str, int]:
        totals = {
            "dosen_seen": 0, "dosen_inserted": 0, "dosen_updated": 0, "dosen_skipped": 0,
            "prodi_seen": 0, "prodi_inserted": 0, "prodi_updated": 0, "prodi_skipped": 0,
        }
        batches = [("dosen", batch) for batch in _payload_batches(profiles)] + [
            ("prodi", batch) for batch in _payload_batches(prodi)
        ]
        if not batches:
            self.finish_run(run_id, "done")
            return totals
        for index, (kind, batch) in enumerate(batches):
            # Gateway hanya menerima UUID v4. Nilai ini tetap sama selama retry
            # karena payload dibuat sekali untuk setiap batch.
            operation_id = str(uuid.uuid4())
            payload = {
                "run_id": run_id,
                "operation_id": operation_id,
                "profiles": batch if kind == "dosen" else [],
                "prodi": batch if kind == "prodi" else [],
                "finalize": index == len(batches) - 1,
            }
            result = self.request("persist_results", payload)
            for key in totals:
                totals[key] += int(result.get(key, 0))
        return totals

    def finish_run(self, run_id: str, status: str, error_message: str | None = None) -> None:
        self.request("finish_run", {
            "run_id": run_id,
            "status": status,
            "error_message": (error_message or "")[:300] or None,
        })

    def list_runs(self, limit: int) -> list[dict[str, Any]]:
        result = self.request("list_runs", {"limit": limit})
        rows = result.get("data", [])
        return rows if isinstance(rows, list) else []

    def records(self, kind: str, *, compact: bool = False) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        after_id = 0
        page_size = 500 if compact else 100
        while True:
            result = self.request("records", {
                "kind": kind, "after_id": after_id, "limit": page_size, "compact": compact,
            })
            page = result.get("data", [])
            if not isinstance(page, list):
                raise GatewayError("Respons data gateway tidak valid.")
            rows.extend(item for item in page if isinstance(item, dict))
            if not result.get("has_more"):
                return rows
            next_id = int(result.get("next_after_id", after_id))
            if next_id <= after_id:
                raise GatewayError("Pagination gateway tidak valid.")
            after_id = next_id


gateway_client = SecureGatewayClient()
