1. A module attribution written to an issue on the deployed instance persists, and the issue reads back carrying that module.
2. An attribution naming a label that is not a module in that project's taxonomy is refused by a named code rather than accepted.
3. A second primary module on one issue is refused.
4. An issue refused a second primary still reads back carrying its original primary.
5. An issue holds two or more secondary modules at once.
6. Every module row in the registry carries `kind = 'module'`.
7. A module row carries the parent it was created under.
8. A module's slug is unchanged by a rename of that module's display name.
9. A module row carries a link to a knowledge node.
10. A second module naming a knowledge node another module already holds is refused.
11. A passing-test handoff on an issue with a primary module refreshes that module's knowledge node.
12. A passing-test handoff on an issue with no module attribution refreshes no knowledge node.
13. A passing-test handoff on an unattributed issue returns success rather than an error.
14. The issues-by-module rollup counts primary attributions separately from secondary ones.
15. A module with zero attributed issues appears in the rollup rather than being absent from it.
16. The rollup reports a count of issues carrying no module attribution.
17. The mindmap diagram renders the parent hierarchy the registry declares.
18. The context diagram renders each module of the project as a node.
19. The user-flow diagram renders steps taken from a module's knowledge node.
20. The swimlane diagram renders one lane per module drawn from module knowledge.
21. A module carrying no knowledge node still appears in a rendered diagram.
22. The drift surface reports each observed co-occurrence with the count of issues that produced it.
23. The drift surface reports an observed co-occurrence the declared graph does not carry under `undeclared`.
24. The drift surface on a project that declares no module graph reports the declaration absent rather than returning an error.
25. A drift response is a success response, and the handoff that produced the co-occurrence keeps its passing verdict.
26. anhome's by-hand `**Module:**` comment convention is retired onto the engine taxonomy.
