import { RoomEvent } from 'livekit-client';
import { sendRoomQuestion } from './aiClient';

const topic = 'ciclope-voice-free-v1';
const normalize = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const clean = text => text.replace(/^[\s,:.!?;-]+|[\s,:.!?;-]+$/g, '');

export function createVoiceCommands({ room, roomCode, participantId, isOpen, open, close, notice, status }) {
  let parts = [], generation = 0, disposed = false, active = null, speaking = false, utterance = null;
  let chain = Promise.resolve(), speechVersion = 0;
  const seen = new Set();
  const synth = window.speechSynthesis;
  const fail = e => { if (!disposed) notice(e.message || String(e)); };
  const publish = data => room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(data)), { reliable: true, topic });
  const idle = () => status('Ouvindo o comando ABRE');
  function stopSpeech() { speechVersion++; speaking = false; utterance = null; synth?.cancel(); }
  function speak(text, done) {
    stopSpeech();
    if (!synth || !window.SpeechSynthesisUtterance) { notice('Este navegador não oferece síntese de voz. Leia a resposta no chat.'); done(); return; }
    const token = speechVersion;
    const chunks = text.replace(/[*#`]/g, '').match(/[^.!?\n]{1,180}(?:[.!?\n]+|$)?|[.!?\n]+/g) || [text];
    speaking = true;
    const next = () => {
      if (disposed || token !== speechVersion) return;
      const chunk = chunks.shift();
      if (!chunk) { speaking = false; utterance = null; done(); return; }
      const u = new window.SpeechSynthesisUtterance(chunk);
      utterance = u; u.lang = 'pt-BR'; u.rate = 1;
      const voices = synth.getVoices();
      const voice = voices.find(v => v.localService && v.lang.toLowerCase().replace('_','-') === 'pt-br') || voices.find(v => v.lang.toLowerCase().replace('_','-') === 'pt-br');
      if (voice) u.voice = voice;
      u.onend = next;
      u.onerror = e => { if (token !== speechVersion) return; speaking = false; utterance = null; notice('Não foi possível reproduzir a voz: ' + e.error + '. Confira o áudio ou toque em Ativar voz do Ciclope.'); done(); };
      try { synth.resume(); synth.speak(u); } catch (e) { u.onerror({error: e.message}); }
    };
    next();
  }
  function finish(id) { if (active?.id === id) active = null; idle(); }
  function cancel(localOnly = false) {
    generation++; parts = []; const turn = active; active = null; stopSpeech(); idle();
    if (!localOnly && turn) void publish({ type: 'cancel', id: turn.id }).catch(fail);
  }
  function receive(bytes, participant, kind, incomingTopic) {
    if (incomingTopic !== topic || !participant || disposed) return;
    try {
      const msg = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof msg.id !== 'string') return;
      if (msg.type === 'cancel') { if (active?.id === msg.id) { cancel(true); void close('Interação cancelada na sala.'); } return; }
      if (msg.type !== 'answer' || typeof msg.text !== 'string' || msg.text.length > 16000 || seen.has(msg.id)) return;
      if (active && active.id !== msg.id) { notice('Outra resposta está em andamento; consulte o chat.'); return; }
      seen.add(msg.id); if (seen.size > 200) seen.delete(seen.values().next().value);
      active = { id: msg.id }; parts = []; status('Ciclope falando');
      void close('Ciclope respondendo. Microfone fechado.');
      speak(msg.text, () => finish(msg.id));
    } catch { /* ignore malformed packets */ }
  }
  room.on(RoomEvent.DataReceived, receive);
  async function ask() {
    const content = parts.join(' ').trim().slice(0, 4000); parts = [];
    if (!content) { notice('Faça a pergunta antes de dizer AGORA.'); return; }
    const ticket = ++generation;
    const id = `${participantId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    active = { id }; status('Ciclope pensando');
    try {
      await close('Pergunta enviada. Canal de voz fechado.');
      if (ticket !== generation || disposed) return;
      const result = await sendRoomQuestion({ roomCode, participantId, content });
      if (ticket !== generation || disposed) return;
      const answer = [...(result.messages || [])].reverse().find(m => m.role === 'assistant');
      if (!answer?.content) throw new Error('A IA não retornou uma resposta.');
      status('Ciclope falando');
      const text = answer.content.slice(0, 16000);
      // Send one answer, rather than generating a separate answer per participant.
      void publish({ type: 'answer', id, text }).catch(fail);
      speak(text, () => finish(id));
    } catch (e) { if (ticket === generation) { fail(e); finish(id); } }
  }
  async function handle(raw) {
    if (disposed) return;
    const cmd = normalize(raw);
    if (cmd === 'cancelar') { cancel(); await close('Interação cancelada. Canal fechado.'); return; }
    if (speaking || active) return;
    if (cmd === 'abre' || cmd.startsWith('abre ')) {
      if (!isOpen()) { parts = []; await open('comando'); }
      if (!isOpen()) return;
      status('Ouvindo pergunta. Diga AGORA para enviar.');
      raw = clean(raw.replace(/^\s*abre\b/i, ''));
    }
    if (!isOpen() || !raw.trim()) return;
    const end = normalize(raw) === 'agora' || /\bagora[\s.!?,;:]*$/i.test(raw);
    const content = clean(end ? raw.replace(/\bagora[\s.!?,;:]*$/i, '') : raw);
    if (content) parts.push(content);
    if (end) void ask();
  }
  return {
    handle(raw) { chain = chain.then(() => handle(raw)).catch(fail); return chain; },
    unlock() { if (active || speaking) return; speak('Voz do Ciclope ativada.', () => idle()); },
    cancel,
    dispose() { disposed = true; cancel(true); room.off(RoomEvent.DataReceived, receive); }
  };
}
