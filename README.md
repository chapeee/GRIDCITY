# GRIDCITY

## Setup

1. Clone the repository.
2. Copy the environment template and adjust values as needed:

   ```bash
   cp .env.example .env
   ```

## Environment variables

| Variable       | Description                | Default    |
| -------------- | -------------------------- | ---------- |
| `PROJECT_NAME` | Name of the project (single source of truth) | see `.env.example` |

`.env` is git-ignored; only `.env.example` is committed.

## Renaming the project

The project name is kept in one place, `PROJECT_NAME`. To rename the project:

1. Change `PROJECT_NAME` in `.env` and `.env.example`.
2. Change the title (first line) of this README.

Code and config should read `PROJECT_NAME` and never hardcode the name.

## Agent

A Claude Code project agent lives in [`.claude/agents/project-agent.md`](.claude/agents/project-agent.md). It has a name-neutral filename, so it won't need changing if the project is renamed. In Claude Code, invoke it with `@project-agent` or ask Claude to use the `project-agent` agent.

## Project structure

```
.
├── .claude/agents/project-agent.md   # Claude Code project agent
├── .env.example                 # Environment template
├── .gitignore
├── LICENSE
└── README.md
```

## License

Licensed under the [Apache License 2.0](LICENSE).
