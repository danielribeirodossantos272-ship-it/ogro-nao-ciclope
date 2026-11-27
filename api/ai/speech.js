import { createSign } from "node:crypto";

const GOOGLE_TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_VOICE = "pt-BR-Wavenet-B";
let cachedGoogleToken = null;
let cachedGoogleTokenExpiresAt = 0;
const MAX_TEXT_LENGTH = 12000;
const MAX_CHUNK_BYTES = 4500;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.end(JSON.stringify(payload));
}

function getConfig() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const serviceAccountJson = process.env.GOOGLE_TTS_SERVICE_ACCOUNT_JSON;

  if (!supabaseUrl || !supabaseKey) {
    const error = new Error("Backend Supabase não configurado. Defina SUPABASE_URL e SUPABASE_SECRET_KEY.");
    error.status = 500;
    throw error;
  }
  if (!serviceAccountJson) {
    const error = new Error("A voz do Ciclope ainda não está configurada. Adicione GOOGLE_TTS_SERVICE_ACCOUNT_JSON nas variáveis da Vercel.");
    error.status = 503;
    throw error;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch {
    const error = new Error("GOOGLE_TTS_SERVICE_ACCOUNT_JSON não contém um JSON válido da conta de serviço.");
    error.status = 500;
    throw error;
  }

  if (serviceAccount?.type !== "service_account" || !serviceAccount.client_email || !serviceAccount.private_key) {
    const error = new Error("A credencial Google precisa ser uma chave JSON de conta de serviço com client_email e private_key.");
    error.status = 500;
    throw error;
  }

  return {
    supabaseUrl: supabaseUrl.replace(/\/$/, ""),
    supabaseKey,
    serviceAccount,
    voiceName: process.env.GOOGLE_TTS_VOICE || DEFAULT_VOICE
  };
}

async function supabaseFetch(path, config) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
    headers: {
      apikey: config.supabaseKey,
      "Content-Type": "application/json",
      ...(config.supabaseKey.startsWith("sb_secret_")
        ? {}
        : { Authorization: `Bearer ${config.supabaseKey}` })
    },
    signal: AbortSignal.timeout(15000)
  });

  const body = await response.text();
  if (!response.ok) {
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      detail = parsed?.message || parsed?.hint || body;
    } catch {
      // A resposta do Supabase não era JSON.
    }
    const error = new Error(`Supabase respondeu ${response.status}: ${detail}`);
    error.status = response.status;
    throw error;
  }

  return body ? JSON.parse(body) : null;
}

function normalizeRoomCode(value) {
  return String(value || "").trim().toUpperCase();
}

async function findRoom(roomCode, config) {
  const query = `rooms?select=id,code&code=eq.${encodeURIComponent(roomCode)}&limit=1`;
  const rows = await supabaseFetch(query, config);
  return rows?.[0] || null;
}

async function findParticipant(roomId, participantId, config) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(participantId)) {
    return null;
  }

  const query = `room_participants?select=id&room_id=eq.${encodeURIComponent(roomId)}&id=eq.${encodeURIComponent(participantId)}&limit=1`;
  const rows = await supabaseFetch(query, config);
  return rows?.[0] || null;
}

function cleanTextForSpeech(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " O trecho de código está disponível no chat. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)?[^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\*\*|__|~~|\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function splitLongToken(token, maxBytes) {
  const pieces = [];
  let current = "";

  for (const character of token) {
    if (current && byteLength(current + character) > maxBytes) {
      pieces.push(current);
      current = "";
    }
    current += character;
  }

  if (current) pieces.push(current);
  return pieces;
}

function splitTextIntoChunks(text, maxBytes = MAX_CHUNK_BYTES) {
  const tokens = text.match(/\S+\s*/g) || [];
  const chunks = [];
  let current = "";

  for (const token of tokens) {
    const pieces = byteLength(token) > maxBytes ? splitLongToken(token, maxBytes) : [token];

    for (const piece of pieces) {
      if (current && byteLength(current + piece) > maxBytes) {
        chunks.push(current.trim());
        current = "";
      }
      current += piece;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}


function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function getGoogleAccessToken(config) {
  if (cachedGoogleToken && Date.now() < cachedGoogleTokenExpiresAt - 60000) {
    return cachedGoogleToken;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: config.serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));
  const unsignedAssertion = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsignedAssertion);
  signer.end();
  const privateKey = String(config.serviceAccount.private_key).replace(/\\n/g, "\n");
  const signature = signer.sign(privateKey).toString("base64url");
  const assertion = `${unsignedAssertion}.${signature}`;

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    }),
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const error = new Error(payload?.error_description || payload?.error || "Não foi possível autenticar no Google Cloud.");
    error.status = 502;
    throw error;
  }

  cachedGoogleToken = payload.access_token;
  cachedGoogleTokenExpiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
  return cachedGoogleToken;
}

async function synthesizeChunk(text, config, accessToken) {
  const response = await fetch(GOOGLE_TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      input: { text },
      voice: {
        languageCode: "pt-BR",
        name: config.voiceName
      },
      audioConfig: {
        audioEncoding: "MP3",
        speakingRate: 1,
        pitch: 0
      }
    }),
    signal: AbortSignal.timeout(25000)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `Google Text-to-Speech respondeu ${response.status}.`;
    const error = new Error(message);
    error.status = response.status === 429 ? 429 : 502;
    throw error;
  }

  if (typeof payload.audioContent !== "string" || !payload.audioContent) {
    throw new Error("O serviço de voz não retornou o áudio.");
  }

  return payload.audioContent;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Método não permitido." });
  }

  try {
    const config = getConfig();
    const source = req.body || {};
    const roomCode = normalizeRoomCode(source.roomCode);
    const participantId = String(source.participantId || "").trim();
    const text = cleanTextForSpeech(source.text);

    if (!/^[A-Z0-9]{8}$/.test(roomCode)) {
      return sendJson(res, 400, { error: "Código da sala inválido." });
    }
    if (!text) return sendJson(res, 400, { error: "Não há texto para transformar em voz." });
    if (text.length > MAX_TEXT_LENGTH) {
      return sendJson(res, 413, { error: `A resposta é longa demais para a reprodução (${MAX_TEXT_LENGTH} caracteres no máximo).` });
    }

    const room = await findRoom(roomCode, config);
    if (!room) return sendJson(res, 404, { error: "Sala não encontrada." });

    const participant = await findParticipant(room.id, participantId, config);
    if (!participant) {
      return sendJson(res, 403, { error: "Participante não pertence a esta sala. Entre novamente na sala." });
    }

    const chunks = splitTextIntoChunks(text);
    if (!chunks.length) return sendJson(res, 400, { error: "Não foi possível preparar o texto para voz." });

    // A síntese acontece uma única vez no servidor. O navegador publicará o áudio
    // resultante como uma faixa LiveKit para que todos ouçam a mesma gravação.
    const accessToken = await getGoogleAccessToken(config);
    const audioChunks = await Promise.all(chunks.map((chunk) => synthesizeChunk(chunk, config, accessToken)));

    return sendJson(res, 200, {
      audioChunks,
      mimeType: "audio/mpeg",
      voice: config.voiceName,
      chunkCount: audioChunks.length
    });
  } catch (error) {
    console.error("Erro ao gerar voz do Ciclope:", error);
    const status = Number.isInteger(error.status) ? error.status : 500;
    return sendJson(res, status, {
      error: status === 429
        ? "O serviço de voz atingiu o limite temporário. Aguarde e tente novamente."
        : error.message || "Não foi possível gerar a voz do Ciclope."
    });
  }
}
