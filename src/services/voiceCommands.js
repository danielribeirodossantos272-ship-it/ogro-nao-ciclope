import { RoomEvent } from 'livekit-client';
import { getRoomMessages, sendRoomQuestion } from './aiClient';

const topic = 'ciclope-voice-v1';
const normalize = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export function createVoiceCommands({ room, roomCode, participantId, isOpen, open, close, notice, status }) {
  let mode = 'idle', parts = [], timer, version = 0, busy = false, disposed = false, speaking = false, utterance;
  let lastQuestion = '', lastAnswer = '';
  let chain = Promise.resolve();
  const clear = () => { clearTimeout(timer); parts = []; mode = 'idle'; };
  const cancel = () => { version++; clear(); if (utterance) window.speechSynthesis?.cancel(); speaking = false; };
  const fail = e => { if (!disposed) notice(e.message || String(e)); };
  function speak(text) {
    if (disposed || !text || !window.speechSynthesis) return;
    if (utterance) window.speechSynthesis.cancel();
    const current = new SpeechSynthesisUtterance(text.slice(0, 12000));
    utterance = current; current.lang = 'pt-BR'; speaking = true;
    current.onend = current.onerror = () => { if (utterance === current) { speaking = false; utterance = null; } };
    window.speechSynthesis.speak(current);
  }
  async function broadcast(text) {
    if (disposed) return;
    speak(text);
    await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ text })), { reliable: true, topic });
  }
  function receive(bytes, participant, kind, incomingTopic) {
    if (incomingTopic !== topic || !participant || disposed) return;
    try { const { text } = JSON.parse(new TextDecoder().decode(bytes)); if (typeof text === 'string' && text.length <= 12000) { lastAnswer = text; speak(text); } } catch { /* ignore malformed packet */ }
  }
  room.on(RoomEvent.DataReceived, receive);
  async function ask(content) {
    if (disposed || busy || !content.trim()) return;
    clear(); busy = true; const ticket = ++version;
    lastQuestion = content.trim().slice(0, 4000);
    status('Ciclope pensando');
    try {
      await close('Pergunta enviada. Canal de voz fechado.');
      if (ticket !== version || disposed) return;
      const result = await sendRoomQuestion({ roomCode, participantId, content: lastQuestion });
      if (ticket !== version || disposed) return;
      const answer = [...(result.messages || [])].reverse().find(m => m.role === 'assistant');
      if (!answer?.content) throw new Error('A IA não retornou uma resposta.');
      lastAnswer = answer.content;
      await broadcast(lastAnswer);
      status('Ouvindo o comando ABRE');
    } catch (e) { if (ticket === version) { fail(e); status('Ouvindo o comando ABRE'); } }
    finally { busy = false; }
  }
  function collect(text) {
    if (text.trim()) parts.push(text.trim());
    clearTimeout(timer);
    timer = setTimeout(() => { if (parts.length) void ask(parts.join(' ')); else { clear(); status('Canal aberto'); notice('Nenhuma pergunta captada.'); } }, parts.length ? 1800 : 12000);
  }
  async function repeat() {
    if (busy) return;
    try {
      await close('Repetindo a última resposta.');
      if (!lastAnswer) { const history = await getRoomMessages(roomCode, participantId); lastAnswer = [...(history.messages || [])].reverse().find(m => m.role === 'assistant')?.content || ''; }
      if (!lastAnswer) return notice('Ainda não existe resposta para repetir.');
      await broadcast(lastAnswer);
    } catch (e) { fail(e); }
  }
  async function handle(raw) {
    if (disposed) return;
    const cmd = normalize(raw);
    if (cmd === 'cancelar') { cancel(); await close('Comando CANCELAR reconhecido. Canal fechado.'); status('Ouvindo o comando ABRE'); return; }
    if (speaking || busy) return;
    if (cmd === 'abre' || cmd.startsWith('abre pergunta')) { await open('comando'); if (isOpen()) { status('Canal aberto'); if (cmd !== 'abre') await handle(raw.trim().replace(/^abre[\s,:.!?-]*/i, '')); } return; }
    if (!isOpen()) return;
    if (cmd === 'confirmar') { if (mode === 'question' && parts.length) void ask(parts.join(' ')); else { clear(); await close('Confirmado. Canal fechado.'); status('Ouvindo o comando ABRE'); } return; }
    if (cmd === 'repita' || cmd === 'repete' || cmd === 'repetir') { clear(); await repeat(); status('Ouvindo o comando ABRE'); return; }
    if (cmd === 'erro') { clear(); mode = 'question'; notice('Refaça sua pergunta.'); status('Ouvindo nova pergunta'); collect(''); return; }
    if (mode === 'question') { collect(raw); return; }
    if (cmd === 'pergunta' || cmd.startsWith('pergunta ')) { mode = 'question'; status('Ouvindo pergunta'); notice('Faça sua pergunta. Todos na sala podem ouvir você.'); collect(raw.trim().replace(/^pergunta[\s,:.!?-]*/i, '')); }
  }
  return { handle(raw) { chain = chain.then(() => handle(raw)).catch(fail); return chain; }, cancel, dispose() { disposed = true; cancel(); room.off(RoomEvent.DataReceived, receive); } };
}
