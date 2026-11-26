# Configuração da IA compartilhada — Ogro Não, Ciclope

## 1. Variáveis da Vercel

Já configuradas na Vercel para Production:
- `GROQ_API_KEY` (Sensitive)
- `SUPABASE_SECRET_KEY` (Sensitive)

A API usa `VITE_SUPABASE_URL` como URL do Supabase. Essa variável já existe na produção. Opcionalmente, pode-se criar `SUPABASE_URL` com o mesmo endereço para separar explicitamente a configuração do backend.

A `SUPABASE_SECRET_KEY` fica exclusivamente no backend. Nunca use prefixo `VITE_` nela.

## 2. Criar a tabela no Supabase

A tabela `public.room_ai_messages` já foi criada no projeto principal. O arquivo abaixo documenta a migration para recriar a mesma estrutura em outro ambiente:
`supabase/migrations/20261126_create_room_ai_messages.sql`

A tabela fica sem políticas para `anon` e `authenticated`; somente a API server-side, autenticada com `SUPABASE_SECRET_KEY`, lê e grava mensagens. O backend também verifica se o identificador do participante pertence à sala antes de permitir leitura ou envio.

## 3. Publicação

Envie os arquivos do projeto para o repositório mantendo os caminhos. Depois faça o deploy de produção na Vercel. O backend envia a nova chave `sb_secret_` somente no cabeçalho `apikey`; não a envia como `Authorization: Bearer`.

## 4. Teste

1. Abra uma sala em dois dispositivos.
2. Em um deles, envie uma pergunta no painel "Converse com o Ciclope".
3. Aguarde a resposta.
4. Confira se a pergunta e a resposta aparecem nos dois dispositivos.
5. No segundo dispositivo, faça outra pergunta relacionada para confirmar que o histórico é compartilhado.

## 5. API

- `GET /api/ai/messages?roomCode=XXXXXXXX&participantId=UUID`: lê o histórico da sala após validar o participante.
- `POST /api/ai/messages`: recebe `roomCode`, `participantId` e `content`, valida o participante, chama Groq e grava pergunta e resposta na tabela compartilhada.

Modelo inicial: `openai/gpt-oss-20b`. Pode ser alterado pela variável server-side `GROQ_MODEL`.
