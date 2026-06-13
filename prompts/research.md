---
description: Research workflow — scout gathers context, researcher performs deep analysis.
---
Use the crew_chain tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "researcher" agent to perform deep analysis of "$@" using the context from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}.