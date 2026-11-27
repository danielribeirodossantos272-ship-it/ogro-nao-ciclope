async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Falha na comunicação (${response.status}).`);
  }
  return payload;
}

export function getRoomMessages(roomCode, participantId) {
  const query = new URLSearchParams({ roomCode, participantId });
  return request(`/api/ai/messages?${query.toString()}`);
}

export function sendRoomQuestion({ roomCode, participantId, content, signal }) {
  return request("/api/ai/messages", {
    method: "POST",
    body: JSON.stringify({ roomCode, participantId, content }),
    signal
  });
}

export function synthesizeRoomSpeech({ roomCode, participantId, text, signal }) {
  return request("/api/ai/speech", {
    method: "POST",
    body: JSON.stringify({ roomCode, participantId, text }),
    signal
  });
}
