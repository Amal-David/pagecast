# Pagecast Library plugin

This is a local/desktop **read-only** plugin package. `plugin.json` is the
portable Agent Plugins manifest used by current OpenAI clients; the
`.claude-plugin/` and `.mcp.json` files provide Claude Code compatibility.
No remote service or directory listing is registered by these files.

1. Install this checkout's Pagecast package into a trusted Node.js environment
   (Node 20.19+). The new `pagecast-ai-mcp` command is not in the existing npm
   0.7.1 release; use a built local package until a new release is published.
2. Copy this folder to the local plugin location of your client.
3. In **both** `mcp.json` and `.mcp.json`, replace `/ABSOLUTE/PATH/pagecast-home`
   with the intended Home, usually the absolute expansion of `~/.pagecast/home`.
   Replace `command` with the absolute installed `pagecast-ai-mcp` executable if
   your desktop client does not inherit your shell PATH.
4. Review and install the local plugin through your client's supported flow.
   Claude Code local testing: `claude --plugin-dir /absolute/path/to/this/folder`.
5. Ask for the Pagecast report list and verify it matches that Home.

The existing `plugin/` package remains the Claude Code publishing integration.
This smaller library package intentionally does not inherit its automatic
report-detection hooks. Publishing/revocation SDKs, remote-client limitations,
and release gates are described in [the integration guide](../README.md).

Local client installation and marketplace review still need to be performed on
supported clients; schema and protocol tests alone do not establish store approval.
