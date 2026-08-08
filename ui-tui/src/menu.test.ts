import assert from 'node:assert/strict'
import test from 'node:test'

import { commandChoices, filteredOptions, moveSelection, selectedOption, type PickerMenu } from './menu.js'

test('slash completion and picker search use the typed prefix', () => {
  assert.deepEqual(commandChoices('/mo').map(command => command.name), ['/model'])
  assert.deepEqual(commandChoices('/goal '), [])

  const menu: PickerMenu = {
    index: 0,
    kind: 'model',
    options: [
      { id: 'flash', label: 'deepseek-v4-flash [deepseek]' },
      { id: 'mimo', label: 'mimo-v2.5 [mimo]' },
    ],
    query: 'mim',
    title: 'Models',
  }
  assert.deepEqual(filteredOptions(menu).map(option => option.id), ['mimo'])
  assert.equal(selectedOption(moveSelection({ ...menu, query: '' }, -1))?.id, 'mimo')
})
