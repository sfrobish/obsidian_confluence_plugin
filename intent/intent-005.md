---
author: sfrobish
status: accepted
---

# Intent: refactor the instance resolver from OOP

## Problem
There is too much object oriented programming going on here.  There are not that many "objects" here when properly modeled.  For example, there is no need to have a class called "instanceResolver" it doesn't represent a thing.  It just a series of steps to answer questions about related items referenced by links.

## Proposed outcome
Refactor instanceResolver to exported functions.  All calls needed will be changed to function calls instead of object methods.
