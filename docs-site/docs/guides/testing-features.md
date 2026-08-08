# Testing Features Guide

> [!CAUTION]
> Testing versions are **highly unstable** and intended for developers and testers only!
> Features may be incomplete, broken, or removed without notice.

This guide covers features available in the Testing branch (`testing`) of Home-Assistant-Matter-Hub.

---

## ⚠️ Important Warnings

- **Do NOT use in production** - Testing versions may break at any time
- **Data loss possible** - Always backup before testing
- **No support guaranteed** - Issues may take longer to address
- **Features may be removed** - Nothing is final until it reaches Alpha

---

## Installing the Testing Version

### Home Assistant Add-on

Currently, there is no dedicated Testing add-on. To test:

1. Use the Alpha add-on repository: `https://github.com/riddix/home-assistant-addons`
2. Manually update to the testing Docker tag if available
3. Or build from source using the `testing` branch

### Docker

Use the `testing` tag:

```bash
docker run -d \
  --name home-assistant-matter-hub-testing \
  --network host \
  -v /path/to/data:/data \
  -e HAMH_HOME_ASSISTANT_URL=http://homeassistant.local:8123 \
  -e HAMH_HOME_ASSISTANT_ACCESS_TOKEN=your_token \
  ghcr.io/riddix/home-assistant-matter-hub:testing
```

### Building from Source

```bash
git clone https://github.com/RiDDiX/home-assistant-matter-hub.git
cd home-assistant-matter-hub
git checkout testing
pnpm install
pnpm run build
```

---

## Current Testing Features

Testing contains all Alpha features plus experimental changes being actively developed.

### Features Currently in Testing

| Feature | Status | Description |
|---------|--------|-------------|
| All Alpha Features | ✅ Included | Everything from the Alpha branch |
| Experimental Fixes | 🧪 Testing | Bug fixes being validated before Alpha |
| New Device Types | 🧪 Testing | Device types being evaluated |

---

## Reporting Testing Issues

When reporting issues from the Testing branch:

1. **Use the `testing` label** on GitHub issues
2. **Include the exact version** (e.g., `v2.0.0-testing.6`)
3. **Provide full logs** - Testing issues need more context
4. **Describe expected vs actual behavior**
5. **Note if it worked in Alpha/Stable**

### Issue Template for Testing

```markdown
**Testing Version:** v2.0.0-testing.X
**Previous Working Version:** (if applicable)
**Controller:** Apple Home / Google Home / Alexa

**Steps to Reproduce:**
1. ...
2. ...

**Expected Behavior:**
...

**Actual Behavior:**
...

**Logs:**
```
(paste relevant logs here)
```
```

---

## Version Progression

Features flow through branches as follows:

```
Testing → Alpha → Stable (Main)
   ↓        ↓         ↓
Unstable  Testing   Production
```

1. **Testing** - Initial implementation, may be broken
2. **Alpha** - Stabilized, ready for wider testing
3. **Stable** - Production-ready, thoroughly tested

---

## Reverting from Testing

If you encounter critical issues:

1. Stop the Testing container/add-on
2. Switch to Alpha or Stable version
3. Your configuration should be compatible
4. Report the issue on GitHub with full details

```bash
# Docker - switch to alpha
docker pull ghcr.io/riddix/home-assistant-matter-hub:alpha

# Or switch to stable
docker pull ghcr.io/riddix/home-assistant-matter-hub:latest
```

---

## Contributing to Testing

Want to help test new features?

1. **Join the Discussion** - Check GitHub issues for testing requests
2. **Report Issues** - Detailed bug reports are invaluable
3. **Provide Logs** - Help us debug problems
4. **Test Different Controllers** - We need feedback from all ecosystems

### Testing Checklist

When testing a new feature, please verify:

- [ ] Feature works as described
- [ ] No errors in logs
- [ ] Works with Apple Home
- [ ] Works with Google Home
- [ ] Works with Alexa
- [ ] No impact on existing functionality
- [ ] UI displays correctly
- [ ] Configuration persists after restart

---

## Changelog

### v2.0.0-testing.7 (Latest)
- Thermostat mode change fix using pre-commit reactor
- Hidden entity filter fix for scripts
- README documentation updates

### v2.0.0-testing.6
- Full backup with Matter identity files
- Alphabetical bridge sorting in UI

### v2.0.0-testing.1-5
- Initial testing branch setup
- Migration from Alpha features

---

## Acknowledgments

Thank you to everyone who tests unstable versions and provides feedback! Your contributions help make the stable releases better for everyone.

Special thanks to our dedicated testers:
- [@codyc1515](https://github.com/codyc1515) - Extensive thermostat testing and feedback
