# GitHub notifications Google Apps Script

This repo contains Google Apps script to help manage GitHub notifications in your inbox.  This repo is forked from https://github.com/jasonrudolph/OctoGAS, which is a fork of the original OctoGAS implentation https://github.com/btoews/OctoGAS.

**NOTE**: This fork of the script does *not* auto-manage labels.  It is up to the user to create labels in their Gmail inbox that should be applied to messages.

### Features

#### Label

Applies labels to incoming message threads for:

- Author of the Issue/Pull Request
  - requires an `Author` label
- Direct `@mentions`
  - requires a `Direct Mention` label
- Team `@mentions`
  - requires a `Team` folder with labels like `@myorg/myteam` for each team that should be matched
- Watched repositories
  - requires a `Repo` folder with lables like `<owner>/<repo>` for each repository that should be matched
- Meta notifications (added to team, SSH key added, etc...)
  - reqires a `Meta` label

#### Archive

Archives the messages after applying the labels. Disabled by default. Enable by setting `SHOULD_ARCHIVE` to `true`.

### Installation

Because Google Apps Scripts run on Google's infrastructure, you will need to set this script up to run on Google Scripts.

1. Go to [Google Scripts](https://script.google.com/home) and add a new project
1. Add a file to the new project with the contents from [gmail-labler.gs](./gmail-labler.gs)
1. Go to "Edit > Current Project's Triggers"
1. Create a new trigger to run the `main` function of `gmail-labler.gs` however often you want. If you set it to run every minute you will hit a Google rate limit.
