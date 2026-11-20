# Memory Vault

One memory for all your AI tools. This is a lightweight MCP server with a shadcn interface, built to run on Akash.

[![Deploy on Akash](https://raw.githubusercontent.com/akash-network/console/refs/heads/main/apps/deploy-web/public/images/deploy-with-akash-btn.svg)](https://console.akash.network/new-deployment?step=edit-deployment&templateId=akash-network-awesome-akash-memory-vault)

## Quick start

1. Click **Deploy on Akash**. Optionally set a `VAULT_PASSWORD` environment variable to secure your deployment;
2. Open the deployment URL to verify;
3. Connect your AI tools to `https://<deployment-url>/mcp`:
   - **Claude.ai**: Settings → Connectors → Add custom connector;
   - **Claude Code**: `claude mcp add --transport http vault https://<deployment-url>/mcp`, then `/mcp` to log in;
   - **No OAuth support?** Send the password as a bearer token: `Authorization: Bearer <password>`.

Connected apps are listed in **Settings** (the gear icon), where you can revoke them.

## Do not lose your vault

Closing the deployment, or letting it run out of funds, deletes everything on it.

- **Git backup:** Set `BACKUP_REPO` and `BACKUP_TOKEN` to sync to any Git repo;
- **Export / Import:** A full ZIP of your vault. Import overwrites notes with the same path, but does not fully overwrite your vault.

## Settings

| Env var | |
|---|---|
| `VAULT_PASSWORD` | Password for the UI. If you do not set this, anyone can access your memory vault. |
| `BACKUP_REPO` | HTTPS URL of your private Git repo, without credentials. Optional. |
| `BACKUP_TOKEN` | Token (Github: PAT) with write access to that repo. Optional. |
| `PUBLIC_URL` | The vault's public address, e.g. `https://vault.example.com`. Only set if using a custom domain. Optional. |

## Your own domain

1. In the SDL, uncomment `accept:` and put your domain there.
2. Point a CNAME for it at your deployment URL.
3. Put it behind a proxy that provides HTTPS, such as Cloudflare.
4. Set `PUBLIC_URL=https://your-domain` so apps are always given the HTTPS address.
5. After a redeploy, update the CNAME.

## Teaching your AI to use it

The vault sends its own instructions to any provider your connect. Edit them in `INSTRUCTIONS.md` in the web UI.

For tools that support skills, install [`skills/memory-vault`](skills/memory-vault/SKILL.md).

## Good to know

1. Your Akash provider may be able to see inside the container. Do not store secrets, unless you are willing to take that risk.
2. Changing `VAULT_PASSWORD`, or redeploying, will require you to re-authorize your connected apps.
3. Maximum single file size is 50 MB, due to Akash server ingress limitations.

## Run it yourself

```sh
docker build -t memory-vault .
docker run -p 8080:8080 -v vault:/data memory-vault
```

## License

MIT
