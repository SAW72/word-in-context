# The Word in Context — AI Content → Buffer

Bible **Q&A** social posts (question + short study answer + trial CTA), scheduled via Buffer free API.

**Separate** Buffer pages from Invoicing Agent and Trail Tracker.

---

## Render env

```bash
BUFFER_API_KEY=...                    # Buffer personal key (WIC brand only)
XAI_API_KEY=...                       # already used by the app
SHARE_SITE_URL=https://www.thewordincontext.org
# Free Buffer = 3 channels max. Pick three, e.g. FB+IG+X or FB+IG+TikTok.
CONTENT_NETWORKS=facebook,instagram,x
# Or: CONTENT_NETWORKS=facebook,instagram,tiktok
# Free queue tight? CONTENT_NETWORKS=facebook
# Optional pin if auto-match fails:
# BUFFER_CHANNEL_FACEBOOK=...
# BUFFER_CHANNEL_INSTAGRAM=...
# BUFFER_CHANNEL_X=...
# BUFFER_CHANNEL_TIKTOK=...
CONTENT_TIMEZONE=America/New_York
ADMIN_PASSWORD=...                    # already used for /admin
```

Optional:
```bash
BUFFER_CHANNEL_FACEBOOK=...
BUFFER_CHANNEL_INSTAGRAM=...
XAI_MODEL=grok-4.3
```

Redeploy after saving.

---

## Buffer setup

1. Free Buffer account (or paid multi-brand)  
2. Connect **The Word in Context** Facebook Page + Instagram  
3. Personal API key with **postsWrite**  
4. Set `BUFFER_API_KEY` on this Render service only  

Free plan: no first-comment field; ~10 scheduled posts/channel.

---

## Admin UI

1. Open `https://www.thewordincontext.org/admin`  
2. Log in with `ADMIN_PASSWORD`  
3. **AI content → Buffer (Bible Q&A)**  
   - Status / test  
   - Smoke (1 post)  
   - Generate week → **Generate videos** → Publish  
   - **Requeue Instagram only** (after IG disconnect — does not re-post Facebook)  
   - Publish queued  
   - Export pack / Copy  

Images: `https://www.thewordincontext.org/content-media/share-bg-vertical.jpg`

If Instagram was disconnected and Buffer wiped the IG queue: reconnect IG → **Requeue Instagram only** → **Publish queued**.

---

## Post format

```
Q: <honest study question>

A: <short answer with context / references when possible>

(Study aid — read the passage yourself.)

Soft CTA

https://www.thewordincontext.org

#TheWordInContext #BibleStudy …
```

Every caption **must** include the site. The generator and Buffer publish path force  
`https://www.thewordincontext.org` (or bare `thewordincontext.org`) if the model omits it.  
Set `SHARE_SITE_URL=https://www.thewordincontext.org` on Render if media URLs look wrong.

---

## API (Bearer admin JWT)

| Method | Path |
|--------|------|
| GET | `/api/content/status` |
| GET | `/api/content/buffer/test` |
| POST | `/api/content/buffer/smoke` |
| POST | `/api/content/generate` |
| POST | `/api/content/requeue-instagram` `{ limit? }` |
| POST | `/api/content/publish` |
| GET | `/api/content/export` |
