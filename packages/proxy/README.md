# Docker OpenAI proxy

This entry point runs the repository's standalone model runtime behind its
inference-only relay. The public listener supports the OpenAI compatible
`/v1/models`, `/v1/chat/completions`, and `/v1/responses` routes. It also keeps
the existing Anthropic Messages routes. The management server remains bound to
the container's loopback interface and is not published.

## Start with the published image

The CI workflow publishes a `linux/amd64` image to:

```text
registry.yudream.online/library/dsh-our-free-model-proxy:latest
```

Start the published image with Compose:

```bash
cp .env.example .env
openssl rand -hex 32
# Put the generated value in .env as OFM_API_KEY.
docker compose pull
docker compose up -d
```

Use `OFM_IMAGE_TAG=sha-xxxxxxx` in `.env` to pin a commit image.

## Build locally with Docker Compose

```bash
cp .env.example .env
openssl rand -hex 32
# Put the generated value in .env as OFM_API_KEY, then start the service.
docker compose up -d --build
```

The default OpenAI client settings are:

```text
Base URL: http://127.0.0.1:8080/v1
API Key:  the OFM_API_KEY value in .env
```

## Automatic `free-model` route

The Docker entry point publishes a stable virtual model id named `free-model`.
It walks an ordered, cross-provider fallback chain and switches only before any
visible answer or tool call has reached the client. By default it tries the
native OpenCode free lane first, then the Kilo free routers and concrete free
models. An OpenCode `429 Free usage limit reached` therefore falls through to a
different free upstream instead of ending the request. If every candidate is
rate limited, the proxy preserves an OpenAI-compatible HTTP 429 response.

Use the same model id with each supported protocol surface:

| Client style | Endpoint |
| --- | --- |
| OpenAI Chat Completions | `POST /v1/chat/completions` |
| OpenAI Responses | `POST /v1/responses` |
| Anthropic Messages | `POST /v1/messages` |
| Gemini GenerateContent | `POST /v1beta/models/free-model:generateContent` |
| Gemini streaming | `POST /v1beta/models/free-model:streamGenerateContent?alt=sse` |

OpenAI and Anthropic clients may use `Authorization: Bearer ...` or `x-api-key`.
Gemini clients may use `x-goog-api-key` or the `key` query parameter. In every
case the value is the same `OFM_API_KEY` configured on the container.

Verify the deployment:

```bash
set -a; . ./.env; set +a
curl -fsS http://127.0.0.1:${OFM_PUBLIC_PORT:-8080}/v1/models \
  -H "Authorization: Bearer $OFM_API_KEY"
```

Example with the OpenAI Python SDK:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8080/v1",
    api_key="the same OFM_API_KEY value",
)

models = client.models.list()
result = client.chat.completions.create(
    model=models.data[0].id,
    messages=[{"role": "user", "content": "hello"}],
)
print(result.choices[0].message.content)
```

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OFM_API_KEY` | yes | none | Credential accepted by the public inference relay |
| `OFM_PORT` | no | `8080` | Port inside the container |
| `OFM_DATA_DIR` | no | `/data` | Persistent settings, credentials, and statistics |
| `OFM_NO_REFRESH` | no | `false` | Skip catalogue refresh at startup and on its timer |
| `OFM_FREE_MODEL_CANDIDATES` | no | cross-provider free chain | Ordered comma-separated model ids behind `free-model`; set `off` to remove the alias |
| `OFM_PUBLIC_PORT` | Compose only | `8080` | Host port mapped to container port 8080 |
| `OFM_IMAGE_TAG` | Compose only | `latest` | Published image tag pulled by Compose |

The Compose service uses a named volume for `/data`, runs as the unprivileged
`node` user, drops Linux capabilities, and mounts the root filesystem read-only.
Only the inference relay is published. Its key is persisted as
`standaloneLanKey`; the loopback service uses a separate generated key.

To rotate the public key, change `OFM_API_KEY` and recreate the container:

```bash
docker compose up -d --force-recreate
```

The OpenCode and Kilo free lanes work through the same runtime as the upstream
project. EAC, account channels, aggregate providers, routing chains, streaming,
and tool calls remain in the runtime and use the persistent `/data` directory.
Requests still go to the selected model provider; this container is a self-hosted
protocol proxy and does not run the models locally.

When `/data` is a bind mount, make the directory writable by UID 1000 before
starting the container. Bun is included in the image because the OpenCode free
inference lane uses its network transport.
