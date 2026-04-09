# SillyTavern-FABSheet

# Flow & Brand TRPG Sheet

SillyTavern extension for real-time TRPG character sheet visualization.

## Features

- **No additional API calls** — parses `<tableEdit>` blocks from existing chat responses
- Real-time side panel with tabs: Status / Character / Inventory / Missions / Raw Data
- Auto-scans chat history on load
- Data persists in chat metadata (per-chat)

## Installation

1. Open SillyTavern
2. Go to Extensions → Install Extension
3. Enter the Git URL: `https://github.com/YOUR_USERNAME/SillyTavern-FABSheet`
4. Click Install
5. Reload SillyTavern

## How It Works

The extension injects table state into the system prompt before each generation. The AI includes `<tableEdit>` blocks in its responses when data changes. The extension parses these blocks and updates its internal data store — no extra API calls needed.

### tableEdit Format
