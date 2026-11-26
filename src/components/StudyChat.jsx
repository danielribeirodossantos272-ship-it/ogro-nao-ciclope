import React, { useCallback, useEffect, useRef, useState } from "react";
import { getRoomMessages, sendRoomQuestion } from "../services/aiClient";
import "./StudyChat.css";

export default function StudyChat({ roomCode, participantId, participantName }) {
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [error, setError] = useState("");
  const endRef = useRef(null);

  const refreshMessages = useCallback(async () => {
    try {
      const result = await getRoomMessages(roomCode, participantId);
      setMessages(result.messages || []);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoadingHistory(false);
    }
  }, [roomCode, participantId]);

  useEffect(() => {
    refreshMessages();
    const intervalId = window.setInterval(refreshMessages, 3000);
    return () => window.clearInterval(intervalId);
  }, [refreshMessages]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);

  async function handleSubmit(event) {
    event.preventDefault();
    const content = question.trim();
    if (!content || loading) return;

    setLoading(true);
    setError("");
    setQuestion("");
    try {
      const result = await sendRoomQuestion({ roomCode, participantId, content });
      if (result.messages?.length) {
        setMessages((current) => {
          const byId = new Map(current.map((item) => [item.id, item]));
          result.messages.forEach((item) => byId.set(item.id, item));
          return [...byId.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        });
      }
      await refreshMessages();
    } catch (requestError) {
      setQuestion(content);
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="study-chat" aria-label="Inteligência compartilhada da sala">
      <div className="study-chat-heading">
        <div>
          <p className="eyebrow">INTELIGÊNCIA COMPARTILHADA</p>
          <h3>Converse com o Ciclope</h3>
        </div>
        <span className="study-chat-live">SALA {roomCode}</span>
      </div>

      <div className="study-chat-messages" aria-live="polite">
        {loadingHistory ? (
          <p className="study-chat-empty">Carregando conversa da sala...</p>
        ) : messages.length === 0 ? (
          <p className="study-chat-empty">Faça a primeira pergunta. Todos os participantes desta sala verão a pergunta e a resposta.</p>
        ) : messages.map((message) => (
          <article className={`study-message ${message.role === "assistant" ? "assistant" : "participant"}`} key={message.id}>
            <div className="study-message-meta">
              <strong>{message.role === "assistant" ? "Ciclope" : message.participant_name}</strong>
              <time dateTime={message.created_at}>{new Date(message.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</time>
            </div>
            <p>{message.content}</p>
          </article>
        ))}
        {loading && <p className="study-chat-thinking">Ciclope está pensando...</p>}
        <div ref={endRef} />
      </div>

      {error && <p className="study-chat-error" role="alert">{error}</p>}

      <form className="study-chat-form" onSubmit={handleSubmit}>
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Digite uma pergunta para estudar em grupo..."
          maxLength={4000}
          rows={3}
          disabled={loading}
        />
        <div className="study-chat-form-footer">
          <span>{question.length}/4000</span>
          <button className="primary" type="submit" disabled={loading || !question.trim()}>
            {loading ? "Enviando..." : "Perguntar ao Ciclope"}
          </button>
        </div>
      </form>
      <p className="study-chat-footnote">As mensagens são compartilhadas com os participantes da sala.</p>
    </section>
  );
}
