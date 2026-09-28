Feature: file volatility
  As a user of the app that analyzes a software project,
  I want to see from git the list of the most modified files,
  so that I can quickly identify the files with the highest volatility.
  Volatility is measured by modification frequency, not by the number of changed lines.

  @US1-feature-1-scenario-1
  Scenario: most modified files come first
    Given a project with the following git history:
      """
      r1: src/a.js
      r2: src/a.js, src/b.js
      r3: src/a.js, src/b.js
      r4: src/c.js
      """
    When I open the file volatility view
    Then the volatility list should contain exactly these files in order:
      | path      | changes |
      | src/a.js  | 3       |
      | src/b.js  | 2       |
      | src/c.js  | 1       |

  @US1-feature-1-scenario-2
  Scenario: a modified file shows its relative path and its change count
    Given a project with the following git history:
      """
      r1: README.md
      r2: README.md, src/deep/nested.js
      """
    When I open the file volatility view
    Then the volatility list should contain exactly these files in order:
      | path               | changes |
      | README.md          | 2       |
      | src/deep/nested.js | 1       |

  @US1-feature-1-scenario-3
  Scenario: a file counts one change per revision it was modified in
    Given a project with the following git history:
      """
      r1: src/x.js
      r2: src/y.js
      r3: src/x.js
      r4: src/y.js
      r5: src/x.js
      """
    When I open the file volatility view
    Then the volatility list should contain exactly these files in order:
      | path     | changes |
      | src/x.js | 3       |
      | src/y.js | 2       |

  @US1-feature-1-scenario-4
  Scenario: files with the same number of changes are ordered alphabetically by path
    Given a project with the following git history:
      """
      r1: src/gamma.js, src/beta.js, src/alpha.js
      r2: src/gamma.js, src/beta.js, src/alpha.js
      """
    When I open the file volatility view
    Then the volatility list should contain exactly these files in order:
      | path           | changes |
      | src/alpha.js   | 2       |
      | src/beta.js    | 2       |
      | src/gamma.js   | 2       |

  @US1-feature-1-scenario-5
  Scenario: only modifications inside the analyzed history range are counted
    Given a project with the following git history:
      """
      r1: src/a.js
      r2: src/a.js
      r3: src/b.js
      r4: src/b.js
      """
    When I open the file volatility view for the last 2 revisions
    Then the volatility list should contain exactly these files in order:
      | path     | changes |
      | src/b.js | 2       |

  @US1-feature-1-scenario-6
  Scenario: no modifications in the analyzed history show an explicit message and an empty list
    Given a project with no git commits
    When I open the file volatility view
    Then the volatility list should be empty
    And the volatility result should contain an explicit message
