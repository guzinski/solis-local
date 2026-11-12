import assert from "node:assert/strict";
import {test} from "node:test";
import {errorLanguage,renderErrorPage} from "../src/mobile/error-page.ts";

test("error pages honor supported language priorities and keep details collapsed",()=>{
  assert.equal(errorLanguage("pt-BR, en-US;q=0.8"),"pt-BR");
  assert.equal(errorLanguage("pt-BR;q=0, en-US;q=0.8"),"en-US");
  assert.equal(errorLanguage("fr-FR, pt-BR;q=0.5, en-US;q=0.9"),"en-US");
  const html=renderErrorPage(502,"en-US","Dashboard unavailable");
  assert.ok(html.includes("Your dashboard is temporarily unavailable"));
  assert.ok(html.includes("Technical details"));
  assert.ok(html.includes("<details>"));
  assert.ok(!html.includes("<details open"));
});
test("technical JSON is escaped as text, including hostile markup",()=>{
  const html=renderErrorPage(500,"pt-BR",'<script>alert("x")</script>');
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes('lang="pt-BR"'));
});
