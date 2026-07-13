# V3.1.0
I have developed experimental features on sophron on a seperate branch (no longer functional) and have come up with a list of features that are critical for usage.

## G_O (Global Orchestrator) Flow
- User has a general idea of what they want to build
- User initates a chat with the G_O to discuss possiblities
- They will figure out goal, requirements, the vision, and scale for this project
- G_O will then ask questions about uncertainties if nessacary
- If user asks to not use an agentic template or no templates fit the scenario, G_O should call an **Architect Skill** (not another agent) to give them the details of how to develop a architecture and will then build the architecture. This way, it has full context of the requirements and knows what type of power this project requires instead of another agent going blind to create an architecture.
    - Architecture should also contain the MCP skills and system prompts that the agents will use.
- Using the architecture and the project descriptions, it will propose a project foundation stored as files such that the user can review and adjust if needed.
- If approved, it will then initalize the project and automatically send the starting prompt to the per-project orchestrator to start the project.

## Per-Project Agent Flow
- Describe the current flow to me for a further in-depth knowledge

## Providers
1. providers: remove the default providers, providers should have descriptions to give the architect more information and insight into model usage, remove the default model option, no 1 model fits all scenarios
2. `sophron providers`: lists all configured providers, `sophron providers view <name>`: views all key details about the provider. `sophron providers edit <name> (options)`: Edits providers (api-key, description, etc)

## TUI & Chatting
1. `/model` and `sophron agents edit --model` to change the model of any agent (global-orchestrator, architect (), per-project agents, etc).
2. When in chats, remove the sophron ascii text and bounding box. This will allow the terminal to naturally expand when chats increase in length.
3. ensure that the TUI and chat interfaces are **organized** and **functional**. Output should be conbined with the chat area when viewing agents to increase clarity.
4. The ability to add files to the prompt (`@<file>` to mention a file, agent should automatically have read rights to that file)
5. When typing `@` or `/`, a menu should appear to list commands/files

Learn from other TUIs such as Qwen Code, Hermes, and Claude Code

Please plan out the TUI, a refactor may be required.