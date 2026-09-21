import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settings_changes, apply_settings_changes, manual_rule_ids } from '../src/settings.js';
import { classify } from '../src/rules.js';
import { validate_budget_settings } from '../src/budgets.js';
const baseline = { groups:[],rules:[{id:'a',category:'Food',group:'essential',namePattern:'Shop',priority:1}],mainCategories:[{id:'food',label:'Food'}],categoryMappings:{Food:'food'},subBudgetCaps:{food:5000} };
test('local rules, deletions, mappings and limits survive default import choices', () => {
  const local=structuredClone(baseline); local.rules[0].category='Groceries';local.subBudgetCaps.food=7000; delete local.categoryMappings.Food;
  const incoming=structuredClone(baseline);incoming.rules[0].category='Shopping';incoming.subBudgetCaps.food=6000;incoming.name='LLM proposal';
  const changes=settings_changes(local,incoming,baseline);
  const merged=apply_settings_changes(local,changes,new Set(changes.map((c,i)=>c.protected?-1:i)));
  assert.equal(merged.rules[0].category,'Groceries');assert.equal(merged.subBudgetCaps.food,7000);assert.equal(merged.categoryMappings.Food,undefined);assert.equal(merged.name,'LLM proposal');
});
test('manual rule beats imported rule even when imported numeric priority is higher', () => {
  const local=structuredClone(baseline);local.rules[0].category='Local';
  local._manualRuleIds=manual_rule_ids(local,baseline);local.rules.push({id:'llm',category:'Remote',namePattern:'Shop',priority:999999});
  assert.equal(classify({name:'Shop',betrag_cents:-10},local).category,'Local');
});
test('explicitly selected changes replace protected rules, and first defaults have no conflicts', () => {
  const incoming=structuredClone(baseline);incoming.rules[0].category='New';
  const initial=settings_changes(baseline,incoming,baseline);assert.ok(initial.every(c=>!c.protected));
  const local=structuredClone(baseline);local.rules[0].category='Local';
  const changes=settings_changes(local,incoming,baseline);
  assert.equal(apply_settings_changes(local,changes,new Set([0])).rules[0].category,'New');
});
test('invalid recurring intervals, duplicate IDs and overspending recommendations are rejected', () => {
  const s=structuredClone(baseline);s.rules[0].recurring={intervalMonths:0};assert.throws(()=>validate_budget_settings(s));
  delete s.rules[0].recurring;s.rules.push({...s.rules[0]});assert.throws(()=>validate_budget_settings(s));s.rules.pop();
  s.budgetRecommendation={monthlyIncomeCents:300000,monthlyFixedCents:200000,weeklyLimitCents:30000};assert.throws(()=>validate_budget_settings(s));
});

test('budget order imports unless the user has manually reordered budgets', () => {
 const base={...structuredClone(baseline),mainCategories:[{id:'a',label:'A'},{id:'b',label:'B'},{id:'c',label:'C'}]};
 const incoming=structuredClone(base);incoming.mainCategories.reverse();
 const changes=settings_changes(base,incoming,base);
 assert.deepEqual(apply_settings_changes(base,changes,new Set(changes.map((_,i)=>i))).mainCategories.map(m=>m.id),['c','b','a']);
 const local=structuredClone(base);local.mainCategories=[local.mainCategories[1],local.mainCategories[0],local.mainCategories[2]];
 assert.equal(settings_changes(local,incoming,base).find(c=>c.order).protected,true);
});
