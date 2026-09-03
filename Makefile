.PHONY: release-extensions upload-firefox-extension

release-extensions:
	@node tasks/release-devtools.js

upload-firefox-extension:
	@node tasks/upload-firefox-devtools.js
