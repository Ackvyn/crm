# Contributing to Ackvyn CRM

Thanks for helping improve Ackvyn CRM. Canonical product docs:
https://crm.ackvyn.org/docs/

## Bug reports

Please [open a bug report](https://github.com/Ackvyn/crm/issues/new?template=bug_report.yml)
with:

- What you expected vs what happened
- Steps to reproduce
- Browser / OS, and whether this is CDN console, Worker, or embed
- Site key shape (`{site}`) if relevant (no secrets)

## Feature requests

[Request a feature](https://github.com/Ackvyn/crm/issues/new?template=feature_request.yml)
when you have a clear operator or visitor workflow in mind. We may not take
every idea; describing the problem (not only a solution) helps.

## Pull requests

Small, focused PRs are welcome — bug fixes, docs, and clear UX polish first.

1. Fork and branch from `main`
2. Keep changes scoped (one concern per PR)
3. Follow existing patterns (comment-out-old until confirmed for risky edits in
   the console when applicable)
4. Do not commit secrets (`wrangler.toml` with account IDs, tokens, passphrases)
5. Update docs under `docs/` / `wiki/` when behavior changes
6. Fill out the PR template

Low-quality or mass AI-generated PRs without understanding the codebase may be
closed. Prefer opening an issue first for large features.

## Discussions & questions

Use [GitHub Discussions](https://github.com/Ackvyn/crm/discussions) (or Issues
with the question template) for setup help. Point operators at
[Getting started](https://crm.ackvyn.org/docs/getting-started.html) and
[Worker setup](https://crm.ackvyn.org/docs/worker-setup.html) when that answers
the question.

## Security

Do **not** file public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE.txt) (same spirit as projects like
[Sveltia CMS](https://github.com/sveltia/sveltia-cms)).
