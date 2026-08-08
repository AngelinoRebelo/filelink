# FileLink

Ferramenta web para criar uma **rede temporária** e transferir arquivos entre aparelhos (PC, celular, tablet) na mesma sessão — direto de um dispositivo para o outro via WebRTC.

O servidor só faz sinalização (WebSocket). Os arquivos **não passam pela nuvem**.

## Como usar

1. Abra o site em um aparelho e clique em **Criar rede**.
2. Mostre o **QR code** ou copie o código de 6 caracteres (também dá para compartilhar o link).
3. No outro aparelho, escaneie o QR ou entre com o código.
4. Escolha os arquivos e envie para o aparelho desejado.

## Stack

- Frontend: HTML, CSS, JavaScript (WebRTC DataChannel)
- Backend: Node.js + Express + `ws` (sinalização)
- Deploy: Railway

## Rodar local

```bash
npm install
npm start
```

Abra `http://localhost:3000`.

## Deploy no Railway

1. Conecte este repositório no [Railway](https://railway.app).
2. Crie um serviço a partir do repo (Nixpacks detecta Node).
3. O comando de start é `npm start`.
4. A porta vem de `PORT` (Railway define automaticamente).
5. Healthcheck: `GET /health`.

Depois do deploy, use o domínio público do Railway nos dois aparelhos (mesma URL + mesmo código).

## Observações

- Funciona melhor em HTTPS (necessário para WebRTC em produção).
- Máximo de 8 aparelhos por rede.
- Redes expiram em 2 horas de inatividade estrutural (TTL do servidor).
- Usa STUN público do Google; em redes corporativas muito restritas pode ser necessário TURN.

## Licença

MIT
