# Presto build action

```yaml
permissions:
  contents: read
  id-token: write
  pull-requests: read

steps:
  - uses: actions/checkout@v5
    with:
      ref: ${{ github.event.pull_request.head.sha }}
  - uses: aryamansharda/presto-build@v1
    with:
      scheme: MyApp
```

The action builds an unsigned `iphonesimulator` product, validates its bundle metadata and architectures, packages it, authenticates with GitHub OIDC, uploads directly to private storage, and completes the preview. If GitHub cancels or times out the action before it finishes, the post-run hook replaces the stale Preparing comment with the failure state whenever the runner still has time to perform cleanup.

If one scheme produces more than one iOS app, set `app-name` to the product reviewers should run; Presto uses Xcode’s build settings to locate it. Use `app-path` when an earlier CI step already created the app and Presto should reuse it without compiling again.

## Use your project’s Xcode version

Presto uses the Xcode version already selected in the job. Because the default on `macos-latest` changes over time, teams that pin Xcode should select it before the Presto step and verify the selection:

```yaml
steps:
  - uses: actions/checkout@v5
    with:
      ref: ${{ github.event.pull_request.head.sha }}
  - name: Select Xcode 16.4
    run: |
      sudo xcode-select -s /Applications/Xcode_16.4.app
      xcodebuild -version
  - uses: aryamansharda/presto-build@v1
    with:
      scheme: MyApp
```

Use an Xcode path listed for the chosen [GitHub-hosted macOS runner image](https://github.com/actions/runner-images/tree/main/images/macos). If an existing build job already selects Xcode, keep the Presto step in that job so it uses the same toolchain.

## Private Swift packages and pods

Authenticate private dependencies before the Presto step, just as you do before the project’s existing `xcodebuild` or `pod install` step. The token created by `actions/checkout` normally reads only the current repository; it does not automatically grant access to a different private package or pod repository. Use a repository-scoped, read-only GitHub Actions secret or an SSH deploy key owned by the dependency repository.

When a build log contains a recognized SwiftPM, CocoaPods, HTTPS, or SSH authentication failure, Presto adds a concise GitHub annotation with the next step. That annotation is deliberately static: it never copies a repository URL, username, token, or other potentially sensitive log text.
