var commands = [];

function cmd(info, func) {
  var data = info;
  data.function = func;

  data.dontAddCommandList = !!data.dontAddCommandList;
  data.desc = data.desc || '';
  data.fromMe = data.fromMe || false;
  data.category = data.category || 'misc';
  data.filename = data.filename || 'Not Provided';

  if (!data.dontAddCommandList) {
    commands.push(data);
  }

  return data;
}

module.exports = {
  cmd,
  AddCommand: cmd,
  Function: cmd,
  Module: cmd,
  commands
};
