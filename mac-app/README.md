# @cello-protocol/mac-app

The CELLO widget for Mac, prebuilt: a menu-bar app in one binary for Apple silicon and Intel, signed ad hoc. It shows your agents' questions as banners and in a panel, and sends your answers back to them.

You don't install this yourself. `npm i -g @cello-protocol/cli` brings it on a Mac, and `cello notifier-add mac` puts it in your Applications folder. Other systems skip it.

The source is in `widgets/mac` in the [cello repository](https://github.com/Mygentic-AI/cello), where you can also build it yourself and add it with `cello notifier-add mac --build` or `--app <path>`.
