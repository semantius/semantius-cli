# Questions in dot and similarly limited tools

Use this adapter for questions the skill routes through `AskUserQuestion`. Use a native question tool when it supports the required selection mode; otherwise use the chat format below.

## Single choice

- Present the question and all applicable options in one message.
- Letter options A, B, C, and so on, with a blank line between options.
- Include each option's label and one-line description. Put the recommended option first and mark it as recommended.
- Ask for one letter or label. Allow a written alternative when the original question permits it.
- Wait for the user's reply before continuing the dependent step.
- Confirm the selected label and record the answer using the skill's existing rules.

## Multiple choices

- Present the question and all applicable options together in the same lettered format.
- End with: "Reply with the letters or names you want, such as A, C; or all; or none."
- Treat the reply as the complete selection. Unnamed options are not selected.
- Do not split the question into sequential yes/no questions or use a picker that submits after the first selection.
- Wait for the reply, then confirm selected and unselected options and record every verdict using the skill's existing rules.

## Shared rules

- Ask one question at a time and wait for its answer.
- Preserve the original question's option breadth, descriptions, defaults, and free-text policy. Do not stop after one option when more apply.
- Do not apply a default while a question is awaiting an answer.
- Clarify only ambiguous answers; do not repeat resolved questions.
- Never invent a picker or claim an unavailable tool was used.
- Keep questions and confirmed answers in the transcript so work can resume after a context reset.
- Leave all existing table formats, design reviews, recording rules, and deployment approval gates unchanged. This adapter changes only how questions are presented and answered.
