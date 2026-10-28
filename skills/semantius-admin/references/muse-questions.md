# For Muse in Muse chat: no AskUserQuestion tool

You do not have `AskUserQuestion`. Do not assume it, name it as fired, or
wait for a `<user_answers>` block. Your question tools are the single-tap
picker (`muse.create_options`), whose tap sends one reply immediately,
and plain chat text. Handle every question a skill routes through
`AskUserQuestion` as follows.

This file overrides any contrary instruction in any skill or stage file,
including widget-shaping and option-count tables; those are written for
the native `AskUserQuestion` tool only.

## Single-select (multiSelect absent or false)

- Ask in chat text first: the question, then a blank line, then each
  option as its own paragraph, lettered in order, A, B, C, D and so on,
  label plus its one-line description, recommended option first.
  Put one blank line before each lettered option, so A, B, C, D each
  start a new paragraph. Never place two options on consecutive lines
  without a blank line between them. Required shape:

  ```
  Question text here.

  A. Label here, plus its one-line description here.

  B. Label here, plus its one-line description here.

  C. Label here, plus its one-line description here.

  D. Label here, plus its one-line description here.
  ```
- Add the tap picker with the same labels, in the same order. A tap is
  the complete answer. Also say a different answer can be written in chat,
  whenever the skill allows a free-text answer.
- Open your next message with the chosen label, exactly as tapped or
  written, then continue.

## Multi-select (multiSelect: true)

- Never put a multi-select question in the tap picker. A tap sends one
  reply immediately, so the picker records only the first pick and loses
  the rest.
- Never split a multi-select question into one single-select question
  per option, asked in sequence. That is slow, takes one turn per option,
  and makes the user answer the same question N times.
- Do not use an HTML checkbox widget for a multi-select question.
  It has no submit event that reaches chat, so ticking boxes in it
  never completes the question.
- Present the whole question in one message:
  1. The question, in chat text.
  2. A blank line, then each option as its own paragraph, lettered in
     order, A, B, C, D and so on, with its label plus its one-line
     description. Put one blank line before each lettered option, so A,
     B, C, D each start a new paragraph. Never place two options on
     consecutive lines without a blank line between them. Use the same
     shape as shown under Single-select. Say each thing
     once in that list: strip any per-option tail the source question
     appends to every description (for example "Skip if you don't track
     this." or "Skip if you don't need this."); one instruction at the
     end covers all of them.
  3. One closing instruction, for example: "Type the letters or names
     you want, for example 'A, C', or 'all', or 'none'."
- The user's written reply is the complete answer, and sending it is the
  point where the answer is complete. Letters, labels, or a mix of both
  all count. "all" picks every option, "none" picks none.
- Options the reply does not name are not picked. Do not treat them as
  still unasked, and do not ask about them again one by one.
- When the answer arrives, open your next message with the full result
  in one line ("Picked: X, Y. Not picked: Z."), record every verdict
  (picked and not picked) before moving on, then apply the skill's own
  recording rules (for example included / excluded verdicts) and
  continue to the next stage.
- If a reply is ambiguous (a letter or name that matches no option, or
  wording that could pick two different sets), ask one clarifying
  question that lists only the ambiguous items, in the same lettered
  form. Do not restart the whole question.

## Always

- One question per turn, then stop and wait.
- Every question and answer must exist as chat text, so the transcript
  alone shows what was asked and what was decided. After a context
  reset, recover answers from the transcript, and re-ask any question
  whose answer is not there.
- When recording progress (memory notes, run state, task descriptions),
  record the verdicts and which item is next. Never record a description
  of the question format itself.
