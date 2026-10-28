// cap sync 之後補上原生端設定：Android 權限、iOS 相機/相簿用途說明
const fs = require('fs'), path = require('path');
const am = path.join(__dirname, 'android/app/src/main/AndroidManifest.xml');
if (fs.existsSync(am)) {
  let x = fs.readFileSync(am, 'utf8');
  const perms = ['android.permission.CAMERA', 'android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_EXTERNAL_STORAGE'];
  for (const p of perms) if (!x.includes(p)) x = x.replace('</manifest>', `    <uses-permission android:name="${p}" />\n</manifest>`);
  if (!x.includes('android.hardware.camera')) x = x.replace('</manifest>', '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n</manifest>');
  fs.writeFileSync(am, x); console.log('AndroidManifest 已補權限');
}
const plist = path.join(__dirname, 'ios/App/App/Info.plist');
if (fs.existsSync(plist)) {
  let x = fs.readFileSync(plist, 'utf8');
  const add = {
    NSCameraUsageDescription: '拍攝全身照或單品照片，用於 AI 試穿合成。',
    NSPhotoLibraryUsageDescription: '從相簿選擇全身照或單品照片，用於 AI 試穿合成。',
    NSPhotoLibraryAddUsageDescription: '把合成結果儲存到相簿。'
  };
  for (const [k, v] of Object.entries(add)) if (!x.includes(k)) x = x.replace('</dict>\n</plist>', `\t<key>${k}</key>\n\t<string>${v}</string>\n</dict>\n</plist>`);
  if (!x.includes('CFBundleDisplayName')) x = x.replace('</dict>\n</plist>', '\t<key>CFBundleDisplayName</key>\n\t<string>試穿吧</string>\n</dict>\n</plist>');
  fs.writeFileSync(plist, x); console.log('Info.plist 已補用途說明');
}
