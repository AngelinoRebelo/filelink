# FileLink

Ferramenta web para criar uma **rede temporária FileLink** e transferir arquivos entre aparelhos (PC, celular, tablet).

Não é necessário estar no mesmo Wi‑Fi: funciona com **dados móveis (4G/5G)** ou redes diferentes. A “rede” é a sessão criada pelo app (código + QR).

- Preferência: envio direto **P2P (WebRTC)**
- Se o P2P não fechar (comum fora do Wi‑Fi), usa **relay pela rede FileLink** automaticamente

## Como usar

1. Abra o site em um aparelho e clique em **Criar rede**.
2. Confirme ou ajuste o **nome do aparelho** (detectado automaticamente).
3. Mostre o **QR code** ou copie o código de 6 caracteres (também dá para compartilhar o link).
4. No outro aparelho, escaneie o QR ou entre com o código.
5. Escolha os arquivos e envie para o aparelho desejado.

### Sem Wi‑Fi / sem internet nenhuma

1. Num aparelho, ative o **ponto de acesso (hotspot)**.
2. No outro, conecte a essa rede Wi‑Fi criada pelo aparelho.
3. Abra o FileLink nos dois e entre na mesma sessão (código/QR).

## Stack

- Frontend: HTML, CSS, JavaScript (WebRTC DataChannel + relay)
- Backend: Node.js + Express + `ws` (sinalização e relay)
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
- Redes expiram em 2 horas (TTL do servidor).
- Sem Wi‑Fi compartilhado, o app tenta P2P e, se falhar, envia pela rede FileLink (relay).

## Licença

MIT
