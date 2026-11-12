import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {messages,resolveLocale,translator,intervalLabel} from '../public/i18n.js';

test('both languages have matching keys and interpolation placeholders',()=>{
  assert.deepEqual(Object.keys(messages['en-US']).sort(),Object.keys(messages['pt-BR']).sort());
  for(const key of Object.keys(messages['en-US'])) {
    const placeholders=(s)=>[...s.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();
    assert.deepEqual(placeholders(messages['en-US'][key]),placeholders(messages['pt-BR'][key]),key);
  }
});
test('language negotiation respects preference order and falls back to English',()=>{
  assert.equal(resolveLocale(['pt-PT','en-US']),'pt-BR');
  assert.equal(resolveLocale(['en-GB','pt-BR']),'en-US');
  assert.equal(resolveLocale(['fr-FR','pt-BR']),'pt-BR');
  assert.equal(resolveLocale(['fr-FR']),'en-US');
  assert.equal(translator('pt-BR')('solarInput',{power:'3,50 kW',time:'14:30'}),'Entrada solar 3,50 kW · atualizado às 14:30');
  assert.equal(intervalLabel(300,'pt-BR'),'5 min');
  assert.equal(intervalLabel(240,'en-US'),'4 min');
  assert.equal(intervalLabel(30,'pt-BR'),'30 s');
});
test('every declared page translation and dynamic key exists in both dictionaries',()=>{
  const markup=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const keys=[...markup.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g),...source.matchAll(/\bt\("([^"]+)"/g)].map(m=>m[1]);
  for(const key of keys) for(const language of ['en-US','pt-BR']) assert.ok(messages[language][key],`${language}: ${key}`);
});
test('APK, package and dashboard version share the same build metadata',()=>{
  const info=JSON.parse(readFileSync(new URL('../public/build-info.json',import.meta.url)));
  const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));
  const gradle=readFileSync(new URL('../android/app/build.gradle.kts',import.meta.url),'utf8');
  assert.equal(info.version,pkg.version);
  assert.ok(Number.isInteger(info.build)&&info.build>0);
  assert.ok(gradle.includes('../public/build-info.json'));
});
