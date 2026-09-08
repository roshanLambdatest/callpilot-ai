# DEMO DATA — Nimbus Agent Testing Product Guide

> This document is fictional demo content included only to test AI Call Copilot.

Nimbus Agent Testing is a fictional enterprise testing platform for conversational and autonomous agents. It supports chat agents, voice agents, IVR menus, inbound phone agents, and outbound phone agents. Teams define an expected workflow or upload product requirements, and Nimbus generates test scenarios covering happy paths, edge cases, adversarial inputs, and policy checks.

## Voice and IVR

Nimbus can test phone-based and IVR agents by placing or receiving calls through configured telephony endpoints. A test can validate prompt handling, menu navigation, interruptions, silence, DTMF inputs, and end-of-call outcomes. For a POC, the customer must provide a reachable test number or SIP/telephony integration and must have permission to test that endpoint.

## Scenario generation

Workflows can be supplied as PDF, DOCX, Markdown, or plain text. Enterprise connectors can also pull requirements from Confluence and Jira. The system converts those materials into structured scenarios. Generated scenarios remain editable before execution.

## Evaluation

Evaluations can check factual correctness, policy adherence, latency, task completion, tool-call behavior, and conversation quality. Voice flows can additionally track transcription quality and response timing. Teams should define acceptance criteria before a formal POC.

## Supported channels

The demo product supports text chat, voice calls, IVR, and image-assisted prompts. Video evaluation is an experimental capability and should not be promised as generally available.
