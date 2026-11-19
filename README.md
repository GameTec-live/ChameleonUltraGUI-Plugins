# ChameleonUltraGUI-Plugins

This repository is the default plugin repository used by the Chameleon Ultra GUI.

This repository is mostly maintained automatically and plugins and plugin changes are submitted via pullrequest. A plugin must be in valid ChameleonUltraGUI format. See: https://github.com/GameTec-live/ChameleonUltraGUI/blob/main/docs/plugins/development.md

Contributions are very welcome.

## Adding your plugin

Your plugin must match a few very basic requirements:

- The name must be sensible
- The description must exist and be sensible
- The plugin must serve a purpose and do so in good faith

Next submit a pullrequest adding `plugins/<id>.plugin.json`. A bot checks it and comments, then a moderator or admin reviews it. Once merged, you own the plugin.

## Updating your plugin

Pullrequests from a plugin's owner that only change their plugin are merged automatically, as long as the update starts using no new APIs that change data or the device, and keeps the plugin's name and description. Anything else goes to a maintainer, and the bot's comment says why.

Call the API directly (`chameleon.cards.list()`) or through a namespace alias (`local ui = chameleon.ui`). The bot rejects code that hides what it calls, such as `load`, `_ENV`, metatables or `chameleon["cards"]`.
