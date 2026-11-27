# Ogro Não, Ciclope

Aplicação de estudo coletivo com salas de voz, histórico compartilhado e IA integrada à Groq.

## Funcionalidades

- Criação e entrada em salas pelo Supabase.
- Áudio em tempo real entre participantes pelo LiveKit.
- Chat da sala com histórico compartilhado no Supabase.
- Respostas de texto geradas pela Groq.
- Voz pt-BR sintetizada uma vez no servidor pelo Google Cloud Text-to-Speech e transmitida a todos os participantes como uma faixa de áudio LiveKit.
- Comandos de voz: `ABRE` e `AGORA`.

## Desenvolvimento

```bash
npm install
npm run dev
```

## Deploy

O projeto usa Vite para a interface e funções serverless em `api/` para comunicação com Groq, Supabase e Google Cloud Text-to-Speech. O deploy é feito pela Vercel.

Mantenha as variáveis existentes de Groq e Supabase. Para ativar a voz, configure `GOOGLE_TTS_SERVICE_ACCOUNT_JSON` na Vercel. Consulte `AI_SETUP.md` e `DEPLOY_VOICE_UPDATE.md` antes de publicar.

## Fluxo por voz

1. Entre na sala, conecte o áudio e ative a reprodução dos participantes.
2. Ative os comandos de voz.
3. Diga `ABRE`, faça sua pergunta e diga `AGORA` para enviar.
4. O Ciclope responde por texto e voz para todos na sala.
5. Para interromper uma interação, use o botão **Encerrar interação / parar resposta** na tela.
