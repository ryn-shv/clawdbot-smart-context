# Pre-Publish Checklist - Smart Context v2.1.1

Complete this checklist before running `npm publish`.

---

## 1. Version & Metadata ✅

- [x] Version is 2.1.1 in package.json
- [x] CHANGELOG.md has v2.1.1 entry
- [x] Git tag v2.1.1 created
- [x] Repository URL correct in package.json
- [x] License file present (MIT)
- [x] Author information correct

**Verification:**
```bash
grep '"version"' package.json
git tag -l | grep v2.1.1
```

---

## 2. Documentation ✅

- [x] README.md updated
- [x] INSTALLATION.md complete
- [x] CONFIGURATION.md complete
- [x] QUICKSTART.md complete
- [x] CHANGELOG.md complete
- [x] All docs have correct version numbers
- [x] All links working (local and external)

**Verification:**
```bash
ls -lh *.md
grep -r "2.1.1" *.md
```

---

## 3. Package Structure ✅

- [x] .npmignore configured correctly
- [x] scripts/ directory included
- [x] test-memory.js included
- [x] No unnecessary files (backups, tests/, etc.)
- [x] All core .js files present
- [x] hooks/ directory included
- [x] tool-results/ directory included

**Verification:**
```bash
npm pack --dry-run
# Should show ~40 files, ~500KB unpacked
```

**Expected files:**
- 34 .js implementation files
- 5 documentation files (.md)
- 7 scripts (including patches)
- test-memory.js
- package.json, LICENSE

---

## 4. Dependencies ✅

- [x] @xenova/transformers: ^2.17.2
- [x] better-sqlite3: ^11.0.0
- [x] No unnecessary dependencies
- [x] engines.node: >=18.0.0
- [x] No security vulnerabilities

**Verification:**
```bash
npm audit
npm outdated
```

---

## 5. Scripts & Automation ✅

- [x] postinstall script defined
- [x] scripts/postinstall.js executable
- [x] scripts/apply-patches.sh executable
- [x] scripts/check-patches.sh executable
- [x] scripts/health-check.sh executable
- [x] Bin commands defined (smart-context-health, smart-context-patches)
- [x] All scripts tested locally

**Verification:**
```bash
ls -l scripts/*.sh
node scripts/postinstall.js
npm run health-check
```

---

## 6. Installation Flow 🔄

### Manual Test Required

1. **Fresh Install Test**
   ```bash
   # In a test directory
   npm pack
   npm install -g clawdbot-smart-context-2.1.1.tgz
   ```

2. **Verify Patches Applied**
   ```bash
   npx smart-context-patches --check
   ```

3. **Verify Health Check**
   ```bash
   npx smart-context-health
   ```

4. **Test in Clawdbot**
   - Add to clawdbot.json
   - Restart gateway
   - Check plugin loads: `clawdbot plugins list`
   - Check logs for initialization
   - Have a test conversation

5. **Run Tests**
   ```bash
   cd $(npm root -g)/clawdbot-smart-context
   node test-memory.js
   ```

### Expected Outcomes

- [ ] Plugin installs without errors
- [ ] Patches applied automatically
- [ ] Health check passes
- [ ] Plugin appears in `clawdbot plugins list`
- [ ] Logs show initialization messages
- [ ] test-memory.js passes all tests
- [ ] Conversations show token reduction

---

## 7. Git Status ✅

- [x] All changes committed
- [x] Clean working directory
- [x] Commit message includes release notes
- [x] Tag v2.1.1 created and annotated
- [x] No uncommitted changes

**Verification:**
```bash
git status
git log --oneline -1
git tag -n v2.1.1
```

---

## 8. GitHub Preparation 🔄

### Before Publishing to npm

- [ ] Push commits to GitHub: `git push origin main`
- [ ] Push tag to GitHub: `git push origin v2.1.1`
- [ ] Verify commits visible on GitHub
- [ ] Verify tag visible on GitHub

### After Publishing to npm

- [ ] Create GitHub release from tag v2.1.1
- [ ] Copy CHANGELOG.md content to release notes
- [ ] Attach tarball to release (optional)

---

## 9. NPM Registry 🔄

### Pre-Publish Checks

- [ ] Logged in to npm: `npm whoami`
- [ ] Have publish access to package
- [ ] Package name available or owned: `npm owner ls clawdbot-smart-context`
- [ ] Dry-run successful: `npm publish --dry-run`

**Verification:**
```bash
npm whoami
npm owner ls clawdbot-smart-context
npm publish --dry-run
```

### Publish

```bash
# From ~/clawd/patches/smart-context/smart-context/

# Final check
npm pack --dry-run

# Publish (production)
npm publish

# Or publish as beta first (safer)
npm publish --tag beta
# Then promote: npm dist-tag add clawdbot-smart-context@2.1.1 latest
```

---

## 10. Post-Publish Verification 🔄

### Immediate Checks (within 5 minutes)

- [ ] Package visible on npm: https://www.npmjs.com/package/clawdbot-smart-context
- [ ] Version 2.1.1 shown
- [ ] README renders correctly on npm
- [ ] Installation works: `npm install -g clawdbot-smart-context@2.1.1`

### Full Verification (within 30 minutes)

1. **Clean Install Test**
   ```bash
   # On a different machine or clean environment
   npm uninstall -g clawdbot-smart-context
   npm install -g clawdbot-smart-context
   npx smart-context-health
   ```

2. **Clawdbot Integration**
   - Configure in clawdbot.json
   - Restart gateway
   - Test conversation
   - Verify memory extraction
   - Check logs

3. **Documentation Links**
   - Verify all links in npm README work
   - Check GitHub repository linked correctly
   - Verify issue tracker accessible

---

## 11. Announcement 🔄

### Communication Channels

- [ ] Create GitHub release with notes
- [ ] Post in Clawdbot Discord/community
- [ ] Update any external documentation
- [ ] Respond to issues/questions

### Release Announcement Template

```markdown
🎉 Smart Context v2.1.1 Released!

New features:
- Hybrid memory system (facts + summaries)
- Automatic installation with patch management
- Complete documentation suite

Bug fixes:
- Memory extraction now processes full conversations
- Config system fixed
- All hooks properly registered

Install:
npm install -g clawdbot-smart-context

Docs: https://github.com/ryn-shv/clawdbot-smart-context
Changelog: [link to CHANGELOG.md]

Questions? https://github.com/ryn-shv/clawdbot-smart-context/issues
```

---

## 12. Rollback Plan 🔄

If critical issues are discovered post-publish:

### Option 1: Deprecate Version

```bash
npm deprecate clawdbot-smart-context@2.1.1 "Critical bug, use 2.0.5 instead"
```

### Option 2: Unpublish (within 72 hours)

```bash
npm unpublish clawdbot-smart-context@2.1.1
```

**Note:** Unpublish only works within 72 hours and requires manual intervention.

### Option 3: Hotfix Release

1. Fix bug in code
2. Bump to v2.1.2
3. Update CHANGELOG.md
4. Commit and tag
5. Publish v2.1.2
6. Deprecate v2.1.1

---

## Summary

### Completed ✅
- Package structure
- Documentation
- Installation scripts
- Git commits and tags
- Dependency verification

### Pending 🔄
- Manual installation test
- GitHub push
- npm publish
- Post-publish verification
- Announcement

### Next Steps

1. Run manual installation test (Section 6)
2. Push to GitHub (Section 8)
3. Publish to npm (Section 9)
4. Verify and announce (Sections 10-11)

---

**Ready to publish?**

If all ✅ items are checked and manual tests pass, proceed with:

```bash
cd ~/clawd/patches/smart-context/smart-context

# Push to GitHub
git push origin main
git push origin v2.1.1

# Publish to npm
npm publish

# Verify
npm info clawdbot-smart-context@2.1.1
```

---

**Last Updated:** 2025-02-09  
**Prepared By:** Release automation
