# Judge prompt

You are the orchestrator's judgement step. A worker wants a decision. Decide whether a **written source** already answers it.

Campaign: **{{CAMPAIGN}}**

## Written sources

### Campaign goal

{{GOAL}}

### Brief

{{BRIEF}}

### Campaign acceptance criteria

{{CAMPAIGN_ACCEPTANCE}}

### Constraints

{{CONSTRAINTS}}

### Standing decisions

{{DECISIONS}}

## What to do

Answer only if one of those sources states the answer. Quote the line you relied on word for word in `--next`, as `cite: <source> § <section>`, and put the decision itself in `--summary` in at most three sentences.

If no source answers it, report `blocked` and say in `--summary` which sources you checked and what is missing. Do not choose a default. Do not reason from general practice. Do not invent a precedent, and do not answer on the human's behalf.

```
{{REPORT_CMD}}
```

## The ticket

Ticket: **{{TICKET_ID}} {{TICKET_TITLE}}**

### What to build

{{TICKET_BODY}}

### Ticket acceptance criteria

{{ACCEPTANCE}}

## The question

{{QUESTION}}

## What the worker already tried

{{SUMMARY}}
