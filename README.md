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

insertRow(tableIndex, {colIndex: "value", …})
updateRow(tableIndex, rowIndex, {colIndex: "newValue", …})
deleteRow(tableIndex, rowIndex)

### Table Schema

| Index | Name | Columns |
|-------|------|---------|
| 0 | 시공간 | 날짜, 시간, 위치, 등장 인물 |
| 1 | 캐릭터 시트 | 인물, 신체적 특징, 성격, 직업, 취미, 좋아하는 것, 거주지, 기타 중요 정보 |
| 2 | 관계 | 인물, 관계, 태도, 호감도 |
| 3 | 임무/특성 | 인물, 임무 or 특성, 위치 or 계열, 기간 or 효과 |
| 4 | 이벤트/의식 | 인물, 이벤트/의식, 날짜, 위치, 감정/결과 |
| 5 | 소지품/전투 | 소유자, 아이템/전투, 상세, 효과/상태 |

## License

MIT
