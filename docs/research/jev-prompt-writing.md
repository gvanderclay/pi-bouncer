# Writing text for Jev (SystemOne) versus writing prompts for chat LLMs

Checked 2026-10-03. Versions: Jev `jev-1.13.0` (the model behind `jev-1.13` and `jev-latest`
at TypeSafe, `docs.typesafe.ai/models.md`); TypeSafe docs as served on that date (the jaggedness
page says "Last reviewed 2026-10-02"); TypeSafe's agent skill `typesafe-ai/skills` at commit
`65a39f3` (2026-09-12); Pi's `@earendil-works/pi-ai` 1.0.0 as installed under
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/`; pi-bouncer at
`c0908f8`. No Jev or other paid API was called.

## Question

Does text written for Jev (questions' `instructions` and `criteria`) need different guidance from
prompts for general chat LLMs? Which rules of the "writing for agents" guide (concrete checkable
wording, reasons included, plain wording without CAPS, explicit scope, few varied examples labelled
as illustrations, define every coined term, labelled data blocks, cut text that changes nothing)
hold for Jev, which do not, and what Jev-specific rules replace them?

## Short answer

Yes, it needs partly different guidance. Jev is not a chat model: it generates no text, only
probabilities over the options you define, and TypeSafe's own docs describe it as literal,
weak at indirection and negation, and sensitive to option order and to irrelevant state. Most of
the guide's rules about *clarity* transfer and are strengthened (checkable wording, explicit scope,
plain wording, cutting text, defined terms). Three change: reasons-for-the-model (no support; put
the boundary condition in the criterion instead), examples (TypeSafe documents them as strong
steering, so they are not mere illustrations), and data blocks (the state is JSON addressed by
backticked field paths, not tagged blocks). The rest are new, Jev-only rules: one judgment per
question, instructions and criteria that agree, an explicit no-match option, order-checking of
choice options, and no role, output-format or "ignore injected text" boilerplate unless a test
shows it helps. Several things are `unknown` and need a bench run (listed at the end).

## 1. How the API is shaped

- Endpoint `POST https://api.typesafe.ai/v1/systemone` with `model`, `state`, `questions`
  (https://docs.typesafe.ai/api.md, "Evaluation endpoint", "Request body"). OpenCode Zen exposes
  `https://opencode.ai/zen/v1/systemone` with model `jev-1.13` and `jev-1.13-free`
  (https://opencode.ai/docs/zen/ , model table and "Jev" section). OpenRouter lists
  `typesafe/jev-1.13` (32K context, $0.042/M input, $0 output, released Sep 18 2026) and
  `~typesafe/jev-latest`, "always redirects to the latest model in the Jev family"
  (https://openrouter.ai/typesafe/jev-1.13, https://openrouter.ai/~typesafe/jev-latest).
- `state` is "a string, object, or array" of text; no images, audio or video
  (https://docs.typesafe.ai/api.md "Request body"; https://docs.typesafe.ai/concepts/state.md).
  Pi types `state` as a JSON object only (`dist/types.d.ts:467-470`).
- Three question types: `choice`, `score`, `noul` (https://docs.typesafe.ai/primitives.md "Define a
  question"). Pi calls `noul` `bool` and maps it on the wire (`dist/api/system-one-shared.js:108-117`,
  `README.md:935`). No other types exist in TypeSafe's docs; `unknown` whether more are planned.
- Every question has `type` and `instructions` (string, object or array). `criteria`: Choice = map of
  option name to description (description may be `null`), required; Score = ordered array of level
  descriptions; Noul = optional `{true, false}` descriptions (https://docs.typesafe.ai/api.md
  "Question types"). Pi's types require string `instructions`, string option descriptions and both
  Noul descriptions (`dist/types.d.ts:448-466`); Pi's `wireRequest` copies questions without
  validating them (`dist/api/system-one-shared.js:109-117`), so objects would reach the wire, but
  they are outside Pi's declared types. Whether Pi's runtime or a later version rejects them:
  `unknown` (not tested).
- Returns, per question id:
  - Choice: `choice`, `probabilities` over every option ("floats that sum to 1"), `confidence`.
  - Score: `score` (probability-weighted level number), `legend`, `probabilities`, `confidence`.
  - Noul: `noul`, the probability of yes; no `confidence`.
  (https://docs.typesafe.ai/api.md "Answer types"; https://docs.typesafe.ai/primitives.md "What
  comes back".) Pi's parser reads the same fields (`system-one-shared.js:37-84`).
- Documented limits: at most 255 options per Choice, at most 10 Score levels
  (https://docs.typesafe.ai/api.md); jev-1.13 context 64k tokens per request and 32k for `state`
  plus the longest single question (https://docs.typesafe.ai/models.md "Current models"). Pi's
  catalogue says 32000 for OpenCode and OpenRouter, 64000 for TypeSafe direct
  (`dist/providers/data/*.json`, `contextWindow`). No documented limit on the number of questions
  per request or on the length of `instructions` or `criteria` beyond that context budget; `unknown`
  whether Zen or OpenRouter add their own. Rate limit 80 requests/s, 100K tokens/s (models.md).
- `confidence` is derived from `probabilities`, not an independent signal (Choice: top probability
  above an even split; formulas in https://docs.typesafe.ai/confidence.md "How confidence is
  calculated"). Pi ignores `temperature` for System One (`README.md:939`).

## 2. TypeSafe's guidance on writing instructions and criteria

All from https://docs.typesafe.ai/ pages unless stated.

- **Short, specific, one judgment.** "Write it as a clear, specific question, or as a statement for
  the model to judge" and ask "a judgment a knowledgeable person makes in a second"
  (`/primitives.md`). "Ask the most explicit, narrow, specific, atomic questions you can ... This is
  probably the most important concept in this guide" (`/concepts/how-to-build-with-system-one.md`
  step "Decompose the questions"). "Keep questions short" (same page, "Use structure in the
  questions"). One Noul, one condition: "Is the customer angry and asking for a refund?" makes "the
  value ... mean less" (`/primitives/noul.md` "Writing a Noul question"). The guidance for agents
  adds a counterweight: "atomic does not mean literal fact extraction or a one-sentence limit"
  (agent skill, https://github.com/typesafe-ai/skills/blob/65a39f3/skills/typesafe-ai/SKILL.md,
  "Design the judgments").
- **Literal reading.** "`jev-1.13` answers the question you wrote, not the one you meant. Scoping
  words, negations, and implied conditions are read at face value." Remedy: "state the exact
  condition ... Put boundary cases in the criteria. When you look at a wrong answer and find
  yourself explaining what you really meant, that explanation is the missing half of the
  instruction" (`/model-jaggedness/jev-1.13.md` "Literal reading").
- **Directness, indirection, negation.** "Instructions carrying double negatives or complex
  indirection are answered less reliably. A question about a property of a property or something
  that requires multiple hops of reasoning costs accuracy. ... write your instructions as directly
  as possible. When possible, identify the relevant parts of state by name" (same page,
  "Indirection").
- **Instructions and criteria must agree.** "When the `instructions` and the `criteria` ask for
  different things, `jev-1.13` might get confused ... a Noul where `true` maps to no and `false`
  maps to yes will perform worse. Aim for instructions which are easy for the average person to read
  and understand ... treat the criteria as an extension of the instruction" (same page,
  "Contradictory instructions and criteria"). A high Noul value should mean yes; do not invert
  ("Is the message free of personal data?") (`/primitives/noul.md`).
- **Name the state fields in backticks, with paths.** "Point questions at specific values when that
  removes ambiguity, and include the backtick characters around each path inside the question",
  e.g. `support.tickets[0].message` (`/concepts/how-to-build-with-system-one.md` "Use structure in
  the input state"; `/primitives.md` "Reference specific fields": "The model then knows which part
  of the state to judge"). How much the backticks matter relative to plain names: `unknown`, no
  measurement published.
- **What the model sees.** Question ids are not sent to the model: "Write the complete question in
  `instructions`, even when the ID seems self-explanatory" (`/primitives.md`, Tip). The option names
  *and* descriptions are sent: "write descriptions that separate the options from each other"
  (`/primitives/choice.md` "Request structure"). Field names inside structured instructions or
  criteria are sent too: "The model sees the names along with the values, so use short names that
  label what follows" (`/primitives/choice.md` "Structured instructions and criteria"). A Score
  level's number and neighbours are not seen: "numbers in the descriptions or the instructions don't
  help" (`/primitives/score.md` "Writing good levels").
- **Criteria content.** Choice: "Start with a one-line description per option. When two options are
  similar and the model keeps confusing them, describe each one with an object ... what the option
  covers, what belongs to a neighboring option instead, and a few example inputs"
  (`/primitives/choice.md`); use the same field names across options
  (`/concepts/how-to-build-with-system-one.md`). Noul: "try your questions with and without
  `criteria` and keep whichever gives better answers on your documents" (`/primitives/noul.md`).
  Score: "Describe situations, not degrees" (`/primitives/score.md`).
- **Examples inside criteria.** Documented as strong steering, not decoration: "Examples steer the
  model, and they only help when they look like your real inputs." For one Safari report, plain
  strings gave score 1.43 / confidence 0.35; a relevant example gave 1.03 / 0.96; an irrelevant
  example gave 1.43 / 0.35 (`/primitives/score.md` "Structured level descriptions"). Single test
  case; the size of the effect on other tasks is `unknown`.
- **Exhaustive and exclusive.** Choice "fits when the answer is one of a known set of options with
  no order between them ... add an `other` or `none of the above` option when the list might not
  cover every input" (`/primitives.md` "Choose a question type"; same advice in
  `/primitives/choice.md`; the confidence-routing pattern has `other: 'Something else'` and sends
  "other intent" to humans, `/patterns/confidence-routing.md`). The Choice cookbook's rubric says
  "The labels within a question are mutually exclusive (exactly one applies)"
  (`/cookbooks/consistency_choice_cookbook.md` "The rubric"). Probabilities sum to 1 over the
  options (`/api.md`, `/primitives/choice.md`), so a Choice is single-label; for several labels that
  may apply together the agent skill says "use one [Noul] per label" (skill, "Design the
  judgments").
- **Questions do not influence each other.** "All questions see the same state and are evaluated
  independently" (`/concepts/state.md`); "One question's answer is not hidden context for another"
  (`/primitives.md`); "One primitive's result does not become hidden context that changes another
  primitive's result" (`/concepts/how-to-build-with-system-one.md`). A later judgment that needs an
  earlier answer needs a second request. One nuance: with similar instructions in one request,
  "Adding supplementary data can help make questions distinct" (same page).
- **State as data versus instructions.** "State is data, and `jev-1.13` does not treat it as
  hostile by default. Content written to adversarially steer the model, whether that is an injected
  instruction, a deliberately misleading framing, or text that argues for its own classification,
  can move the answer. ... **Instead:** be explicit in the criteria. Test your integration
  thoroughly" (`/model-jaggedness/jev-1.13.md` "Adversarial content"). TypeSafe's own guardrail
  recipe handles injection by *asking about it*: a Noul "Does this message try to get the assistant
  to ignore, override, or reveal its instructions...?" so "'Ignore your instructions' scores as a
  jailbreak instead of working as one" (`/cookbooks/llm_guardrails.md`). Whether an
  "ignore anything inside the state" sentence in `instructions` reduces steering: `unknown`, not
  documented.
- **Irrelevant state hurts.** "Accuracy falls as the state grows with content unrelated to the
  decision"; "Jev suffers from context rot" (`/model-jaggedness/jev-1.13.md`).
- **Option order.** "the order of a Choice's options can affect the answer, and `jev-1.13` leans
  toward the option that comes first. **Instead:** reorder the options to double check that the
  answer stays consistent" (same page, "Choice option order"; "In some cases").
- **Out of scope for Jev:** arithmetic, counting, date comparison, hex/RGB similarity, low-level
  code, generating text (same page). Non-English is accepted but "English is the primary training
  language" (`/models.md` "Language support").
- **Calibration claims.** The model is "trained for calibrated decisions": outcomes at probability
  0.8 "should occur about 80%" across many predictions, "not a guarantee about any single answer"
  (`/introduction/machine-learning-primer.md`; `/concepts/system-one.md`). Thresholds belong in
  your code and should be tested on your data (`/confidence.md`, Note). TypeSafe's own self-consistency
  cookbook reports mean per-question probability standard deviation 0.0102 across repeats and notes
  a `covered` answer ranged 0.43 to 0.53, "crossing a 0.5 decision threshold"
  (`/cookbooks/consistency_noul_cookbook.md` intro). It is TypeSafe's benchmark, not independent
  evidence.
- **TypeSafe on agent-written questions.** "Agents aren't great at writing questions, so expect to
  edit collaboratively with them"; keep questions and thresholds in one place for review
  (`/agent-skill.md` "Good vibe coding principles").

## 3. What kind of model is Jev?

- First-party description: "a new model architecture, parallel sampler for maximum efficiency, and
  training method we call ... RLCD" (blog, https://typesafe.ai/blog/introducing-system-one-models-and-jev,
  2026-09-15). Jev "gives up string generation"; it "generates all outputs in a single query",
  in parallel, not token by token (same post).
- "Jev is not fine-tuned or LoRA-adapted with customer data. It is trained with RLCD ... the same
  weights serve every account" (`/models.md` "Customizing Jev"). "Jev is not a chat or
  code-completion LLM. ... It does not generate text, write code, or hold a conversation"
  (`/introduction/coding-agents.md`).
- Parameter count, base model, whether it is a fine-tuned pretrained LLM, and whether it is
  reward-model-like: `unknown`. The primer's diagram caption shows "Pretrained language models
  branch into ... RLCD", which suggests a pretrained-LM start, but that is an image alt text
  (`/introduction/machine-learning-primer.md`), not a statement of how Jev was built.
- Behaviour that reads like a language model: it parses English natural language, is "quite
  literal", suffers context rot and option-order bias (jaggedness page). Behaviour unlike a chat
  model: no output to steer by format, role or reasoning; "no ... explanations of their reasoning"
  (`/concepts/system-one.md`).
- Do not confuse Jev with Pi's `llama-cpp-classify` adapter, which wraps a chat model and reads
  next-token log-probabilities over single-token labels (`README.md:943`); its prompt shape is
  Pi's, not Jev's.
- Consequence for transfer: advice that works by giving a *generating* model something to
  reason from or imitate (persona, format, step-by-step reasons) has no documented mechanism here.
  Advice that works by removing ambiguity from a literal reader transfers.

## 4. General literature (secondary support only)

Used only to note that option/label order and prompt wording effects are well documented in chat
LLMs; Jev's own order bias comes from TypeSafe's page above, not from these.

- Zhao et al., "Calibrate Before Use" (arXiv 2102.09690, 2021): few-shot accuracy varies with prompt
  format, examples and example order; models are biased toward answers near the end of the prompt or
  common in pretraining data.
- Zheng et al., "Large Language Models Are Not Robust Multiple Choice Selectors" (arXiv 2309.03882,
  2023): LLMs prefer particular option positions or IDs ("selection bias").
- Pezeshkpour and Hruschka (arXiv 2308.11483, 2023): LLMs are sensitive to the order of options in
  multiple-choice questions.
- Sclar et al. (arXiv 2310.11324, 2023): meaning-preserving formatting changes move few-shot
  accuracy by large margins (up to 76 points on LLaMA-2-13B).
- Zheng et al., "Judging LLM-as-a-Judge" (arXiv 2306.05685, 2023): LLM judges show position and
  verbosity bias.
- Read only abstracts (arXiv API, 2026-10-03). I did not find or verify a source on how
  label-description wording changes *calibration* of zero-shot classifiers: `unknown`. None of
  these tests Jev.

## 5. How the bouncer uses Jev (read only)

- One request carries five questions: `safety` (choice `safe`/`unsafe`) plus four deny questions
  `effect`, `created`, `user_intent`, `risky_target` (`src/jev.ts:42-58`, `src/jev-questions.ts`).
  Noul questions are declared `noul` and converted to Pi's `bool` (`src/jev.ts:54-58`); results are
  combined in code (`src/jev-questions.ts` `denyScore`), which matches TypeSafe's "combine in code"
  advice.
- The `safety` question's `instructions` are the judge prompt `JUDGE_CRITERIA` (2,362 characters,
  `src/judge.ts:12-27`) plus a paragraph mapping the judge's allow/ask/deny verdict onto `safe` /
  `unsafe` (`src/jev.ts:33-35`), and its criteria define each label by that verdict
  (`src/jev.ts:37-40`). The deny questions' instructions are 98 to 201 characters, criteria 299 to
  662 characters (measured with `node`).
- State is a JSON object whose keys are `flagged`, `working_directory`, `git`, `remotes`,
  `earlier_user_messages`, `session_history`, `user_message`, `command` (`src/judge-request.ts:149-182`);
  the deny questions refer to `command`, `working_directory`, `git`, `session_history`,
  `user_message`, `earlier_user_messages` in backticks, as TypeSafe recommends.
- The file comment says "Wording is Jev's own and may drift from the judge prompt; the deny side of
  the Jev bench catches that. Any rewording needs fresh held-out cases" (`src/jev-questions.ts:1-2`).

Observations for the audit (my reading of sections 2 and 5, not TypeSafe statements): the `safety`
question is the broadest, longest, most indirect text sent (role line, tags `<command>` that do not
exist in a JSON state, a verdict vocabulary the options are defined by, a "treat as red flag"
instruction); the deny questions are close to TypeSafe's style but use inline `e.g.` examples
inside criteria and, in `effect`, list `routine` first.

## Rules for writing Jev text

Each rule: verdict, then evidence. "Guide" means the general writing-for-agents rules named in the
task. Where evidence is only TypeSafe's page, the rule holds for jev-1.13 as of 2026-10-02 and may
change with `jev-latest`.

### General rules that transfer (strengthened)

1. **Concrete, checkable wording: transfers, and is stricter.** State the exact condition the
   answer depends on; put boundary cases in the criteria; describe situations, not degrees. Test: if
   you would explain "what I really meant" after a wrong answer, add that explanation as a condition.
   Evidence: jaggedness "Literal reading"; `/primitives/score.md` "Writing good levels"; Noul
   "any" example in `/primitives/noul.md`.
2. **Plain wording: transfers.** Short, direct sentences an average reader understands; no double
   negatives; no nested conditions. Evidence: jaggedness "Indirection" and "Contradictory
   instructions and criteria". No source on CAPS or other emphasis for Jev: `unknown`; no reason to
   use it, since the model answers "the words written".
3. **Explicit scope: transfers.** Say which part of the state to judge, and what the question is
   not about ("Judge expressed frustration, not issue severity"; "not every topic mentioned").
   Evidence: `/concepts/how-to-build-with-system-one.md` (structured examples with `focus`),
   `/primitives.md` "Reference specific fields".
4. **Define every coined term: transfers, with a Jev twist.** Option names, structured field names
   and descriptions are all sent; question ids are not. So a coined option name like
   `destroys_or_shared` is read as words and must be defined in its description, and no meaning may
   live only in the id. Evidence: `/primitives/choice.md` ("The model never sees the question id.
   The option names and their descriptions are both sent"); `/primitives.md` Tip.
5. **Cut text that changes nothing: transfers, more strongly.** Irrelevant state and (by the same
   mechanism, `unknown` for instruction text) extra instruction text are distractors. "Keep
   questions short." Cut anything that is not a condition, a boundary case or a defined term.
   Evidence: jaggedness "Large state full of irrelevant detail"; how-to-build "Keep questions
   short". Counterweight: boundary cases are not "nothing" and the agent skill says short does not
   mean one sentence.

### General rules that change

6. **"Reasons included": does not transfer as stated.** No source says a rationale sentence
   helps Jev, and TypeSafe's remedy for an underspecified question is a *condition*, not an
   explanation of purpose. Write the rule as a testable boundary ("a glob, a parent directory, or a
   variable assigned nowhere in view"), drop the "because". Whether short reasons are harmless
   or helpful: `unknown`; try with and without on the bench. Evidence: jaggedness "Literal
   reading" (explanation = "missing half of the instruction"), "Indirection"; `/concepts/system-one.md`
   (no reasoning, no explanations).
7. **"Few varied examples labelled as illustrations": changes to "examples are steering, put them
   in a labelled field, and make them match real inputs."** TypeSafe's example field is documented
   to move the answer a lot when relevant (1.43/0.35 to 1.03/0.96) and not at all when unrelated.
   So treat each example as a rule that will be applied, not an illustration; keep them in a named
   `examples` field next to `what` and `not_for`, with the same field names across options;
   whether inline `e.g.` lists inside a string are read as illustrative or as exhaustive:
   `unknown`. Evidence: `/primitives/score.md` "Structured level descriptions";
   `/primitives/choice.md` "Structured instructions and criteria". Caveat: Pi's declared types
   accept only strings; objects would need a Pi change or a deliberate bypass of its types
   (`dist/types.d.ts:448-466`).
8. **"Wrap data in labelled blocks": changes to "put data in named JSON fields and point at them
   by backticked path."** The state is JSON; do not refer in `instructions` or `criteria` to
   blocks, tags or text "above" that the state does not contain. Data that belongs to one question
   (a record, a list of examples) can go in a named field of structured `instructions`. Evidence:
   `/concepts/state.md` ("Use an object ... descriptive name"); `/primitives.md` "Reference
   specific fields"; `/api.md` structured `instructions`. Backtick effect size: `unknown`.

### Rules added for Jev

9. **One judgment per question; one thing a high value means.** Split compound conditions into
   separate questions and combine in code; a Noul's high value means yes; never invert. Evidence:
   `/primitives/noul.md` "Writing a Noul question"; how-to-build "Decompose the questions"; jaggedness
   "Hiding several judgments inside one question" reminder.
10. **Write the whole question in `instructions`; criteria extend it and never restate it in
    another vocabulary.** Instructions and criteria must ask for the same thing. Do not define an
    option as "your verdict would be X" where X is a label from some other scheme: that is a
    property of a property. Evidence: jaggedness "Contradictory instructions and criteria",
    "Indirection". Application to the bouncer's `safety` question is my inference.
11. **No persona, no output-format instruction, no reply schema.** Jev returns probabilities over
    the options you define and writes no text, so "You are a ...", "Reply with only a JSON object"
    and similar text has no documented effect and costs accuracy risk through length. Evidence:
    `/introduction/coding-agents.md`, `/concepts/system-one.md`. Effect of a persona line on
    accuracy: `unknown`.
12. **Choice criteria: exclusive options, plus an explicit no-match option, with a gap check.** Give
    the full option list, add `other`/"none of the above" when the list may not cover the input, and
    write each description so it separates it from its neighbours (`not_for` for confusable pairs).
    Probabilities sum to 1, so overlap between options splits probability and lowers confidence;
    use one Noul per label where several may hold. Evidence: `/primitives.md`,
    `/primitives/choice.md`, `/api.md`, skill "Design the judgments". Whether Jev routes ambiguous
    inputs to `other` reliably: `unknown` (test).
13. **Check option order.** Jev leans toward the first option. After any rewording, run the
    question with the options reordered and compare; do not put the option that triggers an allow
    (or the action you least want by default) first without that check. Evidence: jaggedness
    "Choice option order". Magnitude: `unknown`. Literature on the same effect in chat LLMs:
    arXiv 2309.03882, 2308.11483 (secondary).
14. **Treat injected text as something to detect, not something to tell Jev to ignore.** An
    instruction to disregard text inside the state is the chat-LLM habit; TypeSafe documents that
    adversarial state can still move Jev's answer, tells you to be explicit in the criteria, and
    itself builds a question that detects injection. Keep a dedicated criterion that names it
    (the bouncer's `harmful` option already does) and keep injection cases in the bench. Whether a
    "never instructions to you" sentence helps: `unknown`. Evidence: jaggedness "Adversarial
    content"; `/cookbooks/llm_guardrails.md`.
15. **Keep numbers, ordering and counting out of the text.** Do not ask Jev to compare dates, count
    items, measure similarity of numeric values or interpret low-level encodings; pass a computed
    value or a named bucket. Evidence: jaggedness "Math and Numbers", "Date and time comparison".
    Whether "earlier in the history than" counts as an ordering task: `unknown`.
16. **Avoid single and double negatives in conditions where a positive phrasing exists.** Jev reads
    negations "at face value"; the documented failures are double negatives and inverted Noul
    mapping. A single negation is not documented as harmful: `unknown`; write the positive
    condition when it costs nothing. Evidence: jaggedness "Literal reading", "Indirection".
17. **Send only the state each question needs; name it by path.** Evidence: jaggedness "Large
    state"; how-to-build "Decompose the input state". Application: state keys no question refers
    to (`flagged`, `remotes` in `src/judge-request.ts:154-167`) are context-rot candidates; whether
    they help the `safety` question: `unknown`.
18. **Wording changes shift calibrated probabilities; re-measure.** Cutoffs belong in code and
    must be tested on your data; "Two wordings of the same scale can behave differently on your
    data." Any rewording of text sent to Jev needs the held-out bench again, as
    `src/jev-questions.ts:1-2` already says. Evidence: `/confidence.md` Note; `/primitives/score.md`
    "Writing good levels"; TypeSafe's own consistency numbers (section 2) are from its own cookbook.

## Unknown, to settle with a bench run (no paid call made here)

- Whether rationale sentences, a persona line, CAPS, or an "ignore text in the state" sentence
  change any Jev answer: not documented.
- Whether inline `e.g.` examples in criteria strings steer more or less than a structured
  `examples` field, and whether Pi passes structured objects through unchanged.
- Size of the first-option bias on the bouncer's `effect` and `user_intent` questions.
- Whether the `safety` question improves from being shortened and rewritten as a direct question
  with positive criteria.
- Model size and base architecture; any per-instruction length limit enforced by Zen or OpenRouter.
- Whether `jev-latest` (OpenRouter `~typesafe/jev-latest`, TypeSafe `jev-latest`) will stay at
  jev-1.13.0; the alias "moves when a new release ships" (`/models.md` "Aliases").
