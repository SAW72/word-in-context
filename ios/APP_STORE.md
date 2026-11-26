# The Word (Twic) iPhone app: App Store notes

Status: draft shell. Not submitted. Nothing uploaded to App Store Connect.

## Identity
- Bundle ID: com.stewardoftheking.twic
- Team: YY8Q4336XS (STEWARD OF THE KING LLC). Never the personal team.
- Home screen name: The Word (matches the PWA short_name). Bundle name: The Word in Context.
- Version 1.0.0 (1). iPhone only. iOS 17.0 and later. Portrait.
- UIScene lifecycle (UIApplicationSceneManifest plus SceneDelegate). iOS 27 crashes apps without it.

## What is native (Guideline 4.2)
- Read tab: the whole Bible stored on the iPhone, works with no connection.
  BSB (default), KJV, ASV, YLT, Darby, WEB. NET Bible is online only, in the Study tab. ESV is never included.
- Book and chapter picker, swipe between chapters, go to a typed passage.
- Say a passage (speech to text, on device when the iPhone supports it) to open it.
- Listen: on-device text to speech (AVSpeechSynthesizer) for a verse or a chapter.
- iOS share sheet and Copy for any verse.
- Daily verse: opt-in local notification at a time you pick. No push server.
- Haptics on selection, chapter turns, and share.
- Study tab: the web chat at https://thewordincontext.org/app in a Capacitor web view.

## Payments (3.1.1 and 3.1.3(b))
- No prices, trial offers, Whop, or Stripe links in the app.
- The Study tab appends TwicIOS/1.0 to the user agent. Native code hides the subscription box, trial
  banners, Whop notes, and the install banner, and blocks navigation to whop.com, stripe.com, the
  landing page (/), /#signup, and /success.
- People who subscribed on the web can log in (3.1.3(b) multiplatform access).

## Accounts
- The web app has email plus password and magic link sign-in. No third-party login, so Sign in with
  Apple is not required by 4.8.
- Account creation is not offered inside the iPhone app (landing and sign-up pages are blocked).
- Account deletion (5.1.1(v)): there is no self-serve delete endpoint on the server yet. A server change
  is needed before submission: an authenticated two-step delete (request, then confirm) that removes the
  user row, magic tokens, and the Whop link, plus a Delete account button in the app. Blocker for review.

## Privacy
- PrivacyInfo.xcprivacy: UserDefaults (CA92.1) for reading position and settings. No tracking.
- Collected through the Study tab: email (login), questions (to answer them), voice audio (hands-free
  transcription). All for app functionality, linked to the account, not used for tracking.
- The Read tab, daily verse, text to speech, and passage search send nothing to a server. Speech to
  text runs on device when supported; otherwise Apple's speech service processes the audio.
- Privacy policy: https://thewordincontext.org/privacy

## Bible text sources
Built by ios/scripts/build-bible-bundle.js from https://bible.helloao.org/api/<id>/complete.json
(the same API the web app reads), flattened with lib/bible-fetch.js flattenVerseContent.
SHA-256 for every source and bundled file is in ios/App/App/Bible/manifest.json.

| Short | Name | License | Source |
|---|---|---|---|
| BSB | Berean Standard Bible | Public domain (April 2023 dedication) | https://berean.bible/ |
| KJV | King James Version | Public domain outside the UK | https://ebible.org/Scriptures/details.php?id=eng-kjv2006 |
| ASV | American Standard Version (1901) | Public domain | https://ebible.org/Scriptures/details.php?id=eng-asv |
| YLT | Young's Literal Translation | Public domain | https://ebible.org/Scriptures/details.php?id=engylt |
| DBY | Darby Translation | Public domain | https://ebible.org/Scriptures/details.php?id=engDBY |
| WEB | World English Bible | Public domain | https://ebible.org/Scriptures/details.php?id=engwebp |

Verses a translation omits (for example Matthew 17:21 in ASV) are footnote-only in the source and are
left out, the same as the web reader.

## Build (Spencer's Mac only)
    cd ios/App
    xcodegen generate            # project.yml is the source of truth; App.xcodeproj is committed too
    xcodebuild -project App.xcodeproj -scheme Twic -destination 'platform=iOS Simulator,name=iPhone 18 Pro' test
    xcodebuild -project App.xcodeproj -scheme Twic -destination 'id=<device UDID>' -allowProvisioningUpdates build
- Capacitor 8.6.3 comes from ios/vendor/capacitor-swift-pm (official release zips, SHA-256
  1c27a9d6... Capacitor, 80be9d53... Cordova). No npm Capacitor packages, no cap sync needed.
- Rebuild Bible text: npm run ios:bible. Check it: npm run test:ios.

## Before submission (not done here)
- Server: self-serve account deletion (above).
- Web (optional, stronger): when the user agent has TwicIOS, leave the price and trial copy out of
  public/index.html server side (the subscription box, demo banner, signup prompt, tester-ended note)
  instead of relying on the native hide script. /api/config itself carries no prices.
- Reviewer demo account (Spencer provides; username only in notes).
- App Store screenshots, description, and privacy labels in App Store Connect (Spencer or Grok Bot).
