---
author: sfrobish
status: accepted
---

# Intent: refactor the mermaid renderer from OOP and remove online renderer

## Problem
There is too much object oriented programming going on here.  There are not that many "objects" here when properly modeled.  For example, there is no need to have a class called "mermiadRenderer" it doesn't represent a thing.  It just a series of steps to render a diagram.  Also, there is no reason to attempt an online (internet) rendering, as this plugin should always use the obsidian renderer.  Finally, there is no reason not to use svg.  Reduce complexity by eliminating options for online(kroki) rendering and making png images.

## Proposed outcome
Refactor mermaidRenderer to exported functions.  All calls needed will be changed to function calls instead of object methods.  Remove online(kroki) calls.  Only render svg images.

