# @polygonlabs/plugin-primer

## 2.2.2

### Patch Changes

- [#89](https://github.com/0xPolygon/primer/pull/89) [`b4d80cb`](https://github.com/0xPolygon/primer/commit/b4d80cb7079add6e6b4f930f0ca634d123aa11a4) Thanks [@taylanpince](https://github.com/taylanpince)! - Skill guidance: steer the remote HTTP connector away from large inline SVG. The `primer` skill now carves out the remote-connector case in "Diagrams and inline SVG" — on the HTTP connector there is no `contentPath`, so the model is the sole transport and every inlined byte is an output-token cost paid on every version. Large diagrams are pointed at data-driven rendering or hosted-asset URLs instead of inlining; local stdio server guidance (inline freely, `contentPath` keeps the body out of context) is unchanged.

## 2.2.1

### Patch Changes

- [#83](https://github.com/0xPolygon/primer/pull/83) [`e884d4d`](https://github.com/0xPolygon/primer/commit/e884d4dd9faa16a64a38cb62d84830f3b45fbc56) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - The Primer Claude Code plugin is now versioned and released through changesets: the plugin manifest version is updated automatically when a release is cut, so plugin updates reach clients only at release time.
