# Ogro Não, Ciclope

Primeira estrutura do projeto de sala coletiva de estudos por voz.

## Estado desta versão

Esta versão contém somente a interface inicial em React + Vite. Os botões ainda não criam salas reais, não conectam microfones e não chamam provedores de IA. Nenhuma chave de API está incluída.

## Como publicar usando somente o iPhone

1. Extraia este ZIP no iPhone usando o app Arquivos.
2. Entre em https://github.com e crie uma conta ou entre na sua.
3. Crie um repositório novo chamado `ogro-nao-ciclope`.
4. No repositório, use **Add file → Upload files** e envie os arquivos e pastas extraídos, preservando a estrutura.
5. Faça o commit dos arquivos.
6. Entre em https://vercel.com, escolha continuar com GitHub e autorize o acesso ao repositório.
7. Importe `ogro-nao-ciclope` na Vercel. Framework: Vite. Build command: `npm run build`. Output directory: `dist`.
8. Publique. A Vercel fornecerá um endereço para abrir o site.

Se o seletor de arquivos do iPhone não permitir enviar as pastas corretamente, faça o upload dos arquivos em etapas mantendo os caminhos `src/` e `src/App.jsx`, `src/main.jsx`, `src/style.css`.

## Próximas etapas técnicas

- Backend seguro para credenciais e seleção de provedores.
- LiveKit para áudio em grupo.
- Supabase Auth, banco de dados e armazenamento.
- Pipeline de extração de texto/OCR e RAG para materiais.
- Orquestrador de voz e estados: idle → listening → confirmation → answering.
- Fallback entre provedores, com tratamento de limites, erros e custos.

## Segurança

Nunca coloque chaves secretas de APIs em arquivos React, no navegador ou em repositório público. As chaves deverão ficar em variáveis de ambiente do backend.


## Inteligência compartilhada (integração em preparação)

A integração de chat da IA utiliza uma função serverless em `api/ai/messages.js`, o cliente em `src/services/aiClient.js` e o componente `src/components/StudyChat.jsx`. A conversa é armazenada por sala na tabela `public.room_ai_messages`.

Configure `GROQ_API_KEY`, `SUPABASE_SECRET_KEY` e `SUPABASE_URL` (ou reutilize `VITE_SUPABASE_URL`) como variáveis server-side na Vercel. Nunca use prefixo `VITE_` nas chaves secretas. Consulte `AI_SETUP.md` antes de publicar.
