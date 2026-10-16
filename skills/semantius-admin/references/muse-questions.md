# For Muse in Muse chat: no AskUserQuestion tool

You do not have `AskUserQuestion`. Do not assume it, name it as fired, or
wait for a `<user_answers>` block. Your question tools are the single-tap
picker (`muse.create_options`), whose tap sends one reply immediately,
and plain chat text. Handle every question a skill routes through
`AskUserQuestion` as follows.

## Single-select (multiSelect absent or false)

- Ask in chat text first: the question, then one line per option, label
  plus its one-line description, recommended option first.
- Add the tap picker with the same labels, in the same order. A tap is
  the complete answer. Also say a different answer can be typed in,
  whenever the skill allows a free-text answer.
- Open your next message with the chosen label, exactly as tapped or
  typed, then continue.

## Multi-select (multiSelect: true)

- Never put a multi-select question in the tap picker, and never ask for
  the picks as one free-text list. Both have already failed in practice:
  the picker records only the first tap, and a text list has no state and
  no point where the answer is complete.
- Split the question into one single-select question per option, asked
  in sequence, in the order listed:
  1. One intro message lists every option with its description, and says
     you will ask about each one in turn.
  2. For each option, ask "Include <Label>? (<i> of <N>)" in chat text
     with its description, plus a tap picker with exactly two options:
     "Include <Label>" and "Skip <Label>". One question per turn; wait
     for the tap or typed reply before asking about the next option.
  3. Record each verdict as its answer arrives, before moving on. A tap
     you have not recorded is a pick you may lose.
- When every option has an answer, open your next message with the full
  result in one line ("Picked: X, Y. Not picked: Z."), then apply the
  skill's own recording rules (for example included / excluded verdicts)
  and continue to the next stage.
- If the user volunteers several picks in one typed message anyway,
  accept them, treat every unmentioned option as still unasked, and ask
  about the remaining ones individually as above.
- Do not substitute an HTML checkbox widget for this sequence. Its saved
  state has no submit event that reaches chat, so it is a draft, not an
  answer. Build one only when the user asks for one, and even then the
  answers that count are the per-option taps or typed replies in chat.

## Always

- One question per turn, then stop and wait.
- Every question and answer must exist as chat text, so the transcript
  alone shows what was asked and what was decided. After a context
  reset, recover answers from the transcript, and re-ask any question
  whose answer is not there.
