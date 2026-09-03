# SimPreview build action

```yaml
permissions:
  contents: read
  id-token: write
  pull-requests: read

steps:
  - uses: actions/checkout@v5
  - uses: aryamansharda/simpreview-build@v1
    with:
      scheme: MyApp
```

The action builds an unsigned `iphonesimulator` product, validates its bundle metadata and architectures, packages it, authenticates with GitHub OIDC, uploads directly to private storage, and completes the preview.
