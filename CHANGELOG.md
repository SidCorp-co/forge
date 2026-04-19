# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial public release scaffolding (Apache-2.0)
- Project management core: issues, projects, comments, labels, activity log
- 14-status issue pipeline with WebSocket real-time broadcasts
- Agent session runner (Claude CLI + Antigravity cloud) with streaming output
- Four clients: Strapi backend, Next.js web, Tauri desktop, Expo mobile
- Documentation: quickstart, architecture, brand guide, roadmap

### Changed

### Deprecated

### Removed

### Fixed

### Security

---

<!--
Release workflow:
1. Every meaningful PR adds a line to [Unreleased]
2. At release time: rename [Unreleased] to [x.y.z] - YYYY-MM-DD, create a new empty [Unreleased]
3. GitHub Release notes are copied from the version section
-->
