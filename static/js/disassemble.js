/* 
 * Copyright 2016 MongoDB Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* INIT */
var URL_DIE_INFO = "/get_die_info";
var URL_FUNCTION_ASSEMBLY = '/get_function_assembly';

// enums for register tracking/highlighting
var READS_REG = 0;
var WRITES_REG = 1;

var assembly = {
  contents : [], 
  func_name: "",
  active_instruction: "",
  instructions_loading: false,
  in_iaca: false,
  highlight_read_reg: "",
  highlight_write_reg: "",
};

var assembly_ctrl = {
  instructionClicked: instructionClicked // in disassembly_analysis
}

rivets.formatters.isEmptyStr = function(value) {
  return value == "";
}

rivets.bind($("#function-disasm"), 
  {assembly: assembly, ctrl: assembly_ctrl}
);

assembly.instructions_loading = true;
get_function_assembly();

/*************** For register canonicalization ***************/
var register_names_all = [
  ['al', 'ah', 'ax', 'eax', 'rax'],
  ['bl', 'bh', 'bx', 'ebx', 'rbx'],
  ['cl', 'ch', 'cx', 'ecx', 'rcx'],
  ['dl', 'dh', 'dx', 'edx', 'rdx'],
  ['r8b', 'r8w', 'r8d', 'r8'],
  ['r9b', 'r9w', 'r9d', 'r9'],
  ['r10b', 'r10w', 'r10d', 'r10'],
  ['r11b', 'r11w', 'r11d', 'r11'],
  ['r12b', 'r12w', 'r12d', 'r12'],
  ['r13b', 'r13w', 'r13d', 'r13'],
  ['r14b', 'r14w', 'r14d', 'r14'],
  ['r15b', 'r15w', 'r15d', 'r15'],
  ['bpl', 'bp', 'ebp', 'rbp'],
  ['sil', 'si', 'esi', 'rsi'],
  ['dil', 'di', 'edi', 'rdi'],
  ['spl', 'sp', 'esp', 'rsp']];
var register_names = {};
register_names_all.forEach(function(names, index) {
  names.forEach(function(name) {
    register_names[name] = names;
  })
});
for (var i = 0; i <= 15; i++) {
  var names = ['zmm'+i, 'ymm'+i, 'zmm'+i];
  names.forEach(function(name) {
    register_names[name] = names;
  });
}
/* END INIT */

$(function() {
    $.contextMenu({
        selector: '.rip',
        items: {
            rip: {
                name: "Rip Relative",
                callback: function(key, opt) {
                  ripCallback(key, opt, '.rip-default');
                }
            },
            decoded: {
                name: "Resolved Address",
                callback: function(key, opt) {
                  ripCallback(key, opt, '.rip-resolved');

                }
            },
            value_ascii: {
                name: "Referenced Value (ASCII)",
                callback: function(key, opt) {
                  ripCallback(key, opt, '.rip-value-ascii');

                }
            },
            value_hex: {
              name: "References Value (Hex)",
              callback: function(key, opt) {
                ripCallback(key, opt, '.rip-value-hex');
              }
            },
            symbol: {
              name: "Symbol",
              callback: function(key, opt) {
                ripCallback(key, opt, '.rip-symbol');
              },
              disabled: function(key, opt) {
                // We want to show this item iff the rip-symbol element exists
                console.log($(opt.$trigger.context).find('.rip-symbol').length);
                return $(opt.$trigger.context).find('.rip-symbol').length == 0;
              }
            }
        }
    });

  $.contextMenu({
    selector: '.reg',
    items: {
      reads_from: {
        name: "Show reads",
        callback: function(key, opt) {
          var target_reg = $(this)[0].innerText;
          if (target_reg == 'ptr') {
            target_reg = $(this).attr('id');
          }

          var instructs = regsCallback(key, opt, target_reg, READS_REG);
          
          $(".show-read").removeClass("show-read");
          assembly.highlight_read_reg = target_reg;
          instructs.forEach(function(instr) {
            $('#' + instr.address).addClass('show-read');
          });
        }
      },
      writes_to: {
        name: "Show writes",
        callback: function(key, opt) {
          var target_reg = $(this)[0].innerText;
          if (target_reg == 'ptr') {
            target_reg = $(this).attr('id');
          }

          var instructs = regsCallback(key, opt, target_reg, WRITES_REG);
          
          $(".show-write").removeClass("show-write");
          assembly.highlight_write_reg = target_reg;
          instructs.forEach(function(instr) {
            $('#' + instr.address).addClass('show-write');
          }); 
        }
      },
      clear_all: {
        name: "Clear highlighting",
        callback: function(key, opt) {
          clearReadHighlighting();
          clearWriteHighlighting();
        }
      }
    }
  });

});

function ripCallback(key, opt, classToShow) {
  var $rip = $(opt.$trigger.context);
  $rip.find("[class^='rip-']").attr("hidden", "hidden");
  $rip.find(classToShow).removeAttr("hidden");
}

// invoked by context menu;
// highlight the relevant instructions that write to or read from target register
function regsCallback(key, opt, target_reg, readsOrWrites) {
  // canonicalize register names
  var target_reg = target_reg.toLowerCase();
  if (register_names[target_reg]) {
    var target_regs = register_names[target_reg];
  }
  else {
    var target_regs = [target_reg];
  }

  if (readsOrWrites == READS_REG) {
    var mode = "regs_read";
  }
  else if (readsOrWrites == WRITES_REG) {
    var mode = "regs_write";
  }
  else return undefined;
  
  // filter out all instructions that don't include the register in either
  // its implicit or explicit actions
  var instrucs = assembly.contents.filter(function(instr, index) {
    var explicit = instr[mode + "_explicit"].reduce(function(prev, reg) {
      return prev || (target_regs.indexOf(reg) >= 0);
    }, false);
    var implicit = instr[mode + "_implicit"].reduce(function(prev, reg) {
      return prev || (target_regs.indexOf(reg) >= 0);
    }, false);
    return explicit || implicit;
  });
  return instrucs;
}

// clear registers read highlighting
function clearReadHighlighting() {
  $(".show-read").removeClass("show-read");
  assembly.highlight_read_reg = ""
}

// clear registers write highlighting
function clearWriteHighlighting() {
  $(".show-write").removeClass("show-write");
  assembly.highlight_write_reg = "";
}


// for arrows (jump highlighting)
var svg = d3.select('#function-disasm .jump-arrows')
  .append('svg:svg')
  .attr('width', '100%');

svg.append('svg:defs')
  // create arrowhead
  .append('svg:marker')
  .attr({
    'id': 'arrow',
    "viewBox": "0 -5 10 10",
    "refX": 8,
    "refY": 0,
    "markerWidth": 4,
    "markerHeight": 4,
    "orient": "auto",
    "fill": "gray",
  })
  .append('svg:path')
  .attr("d", "M0,-5L10,0L0,5");


function functionClicked(event, model) {
  // handle expansion/collapse of <> in function name
  var el = event.currentTarget;
  if (event.target.classList.contains("expandable")) {
    expandFunctionName(event, model);
    return;
  }
  else if (event.target.classList.contains("collapsable")) {
    collapseFunctionName(event, model);
    return;
  }

  // set class to active and indicate func name
  $(".selected").removeClass("selected");
  el.classList.add("selected");

  // activate loading icon
  assembly.instructions_loading = true;

  // get addr -> line info from server
  // FOR NOW seems unnecessary? may need to bring it back if loading DIEs becomes excessively slow
  begin = el.attributes["data-st-value"].value;
  
  // get function assembly from server
  return _disassemble_function(el);
}

function _disassemble_function(el) {
  return disassemble_function(
    el.innerText, 
    el.attributes["data-st-value"].value, 
    el.attributes["data-offset"].value,
    el.attributes["data-size"].value);
}

// get assembly for given function, given as DOM element
function get_function_assembly() {
  // disassemble function
  var $metadata = $("#function-metadata");
  var st_value = $metadata.attr('data-st-value');
  request_params = {
    filename: $metadata.attr('data-filename'),
    st_value: $metadata.attr('data-st-value'),
    file_offset: $metadata.attr('data-file-offset'),
    size: $metadata.attr('data-size')
  }

  $.ajax({
    type: "GET",
    url: URL_FUNCTION_ASSEMBLY + '?' + $.param(request_params)
  })
  .done(function(data) {
    // Process each line of assembly
    assembly.data = data.map(function(i, index) {
      i.index = index;

      // Process address
      var _address = i.address
      i.address = "0x" + _address.toString(16);

      // Process mnemonic
      var _mnemonic = i.mnemonic;
      i.mnemonic = '';
      i.mnemonic += '<span ';
      i.mnemonic += 'onclick="showFullDescription(event, \'static/inst_ref/' + i['docfile'] + '\')" ';
      i.mnemonic += '>' + _mnemonic;
      i.mnemonic += '</span>';

      // Process op_str
      var _op_str = i.op_str;
      if (i['rip']) {
        var replacementStr =  "";
        replacementStr += '<span class="rip">[';
        replacementStr += '<span class="rip-default">rip + ' + i['rip-offset'] + '</span>';
        replacementStr += '<span class="rip-resolved" hidden>' + i['rip-resolved'] + '</span>';
        replacementStr += '<span class="rip-value-ascii" hidden>"' + i['rip-value-ascii'] + '"</span>';
        replacementStr += '<span class="rip-value-hex" hidden>' + i['rip-value-hex'] + '</span>';
        replacementStr += ']</span>';
        i.op_str = i.op_str.replace(/\[.*\]/, replacementStr);
      }
      else if (i['nop']) {
        i.op_str = i.size + " bytes";
      }
      else if (i['external-jump']) {
        var addr = i.op_str
        i.op_str = '<a href="disasm_function?';
        i.op_str += 'filename=' + $metadata.attr('data-filename');
        i.op_str += '&st_value=' + i['jump-function-address'];
        i.op_str += '&file_offset=' + i['jump-function-offset'];
        i.op_str += '&size=' + i['jump-function-size'];
        i.op_str += '&func_name=' + i['jump-function-name'];
        i.op_str += '">' + addr + '</a>';
      }

      if (i['comment']) {
        i.op_str += '<span class="comment"> # ' + i['comment'] + '</span>';
      }

      if (i['flags']) {
        if (i['flags']['W']) {
          i.has_flag_write = true 
          i['flags']['W'] = i['flags']['W'].join(" ")
        }
        if (i['flags']['R']) { 
          i.has_flag_read = true 
          i['flags']['R'] = i['flags']['R'].join(" ")
        }
      }

      // handle registers
      var regs_str = "";
      if (i['regs_write_implicit'] && i['regs_write_implicit'].length > 0) {
        var regs_write = removeFlagsRegs(i['regs_write_implicit']);
        regs_write.forEach(function(reg, index) {
          if (index == 0) {
            regs_str += "W: ";
          }
          regs_str += '<span>' + reg + '</span>';
        });
      }

      if (i['regs_read_implicit'] && i['regs_read_implicit'].length > 0) {
        var regs_read = removeFlagsRegs(i['regs_read_implicit']);
        regs_read.forEach(function(reg, index) {
          if (index == 0 && regs_str.length > 0) {
            regs_str += ", R: ";
          }
          else if (index == 0 && regs_str.length == 0) {
            regs_str += " R: ";
          }
          regs_str += '<span>' + reg + '</span>';
        });
      }

      if (regs_str.length > 0) {
        regs_str = i['comment'] ? ', ' + regs_str : ' # ' + regs_str;
        i.op_str += "<span class='comment regs'>" + regs_str + "</span>";
      }


      if (!i['short_description']) {
        i['short_description'] = "No description available";
      }
      if (!i['docfile']) {
        i['doctile'] = '404.html';
      }

      // Process etc.
      // Nothing here yet!

      return i;
    });

    // clear loading icon
    assembly.instructions_loading = false;
    assembly.contents = data;

    // syntax highlighting
    $(".instructions span.row.instruction").each(function(i, block) {
      hljs.highlightBlock(block);
    });

    // load jump info
    handleJumpHighlighting();

    // Adds a "hex" or "twosCompDec64" class to all numbers
    wrapAllNumbers();

    // Adds a "reg" class to all registers
    wrapAllRegisters();

    // initialize tooltips
    $('.tip').tipr({
      'speed': 100
    });

    // preload DIE info from server
    $.ajax({
      type: "GET",
      url: URL_DIE_INFO + "?address=" + st_value
    });

  })
  .fail(function(data) {
    console.log("Request failed");
  });

  return false;
}

function removeFlagsRegs(reg_array) {
  var flags_index = reg_array.indexOf('rflags');
  if (flags_index > -1) {
    reg_array.splice(flags_index, 1);
  }
  return reg_array;
}

// display jump arrows
function handleJumpHighlighting() {
  // load jump info
  var reverseJumps = {}
  for (var i = 0; i < assembly.contents.length; i++) {
    var line = assembly.contents[i];
    if (line['internal-jump'] && line['jump-address'] in reverseJumps) {
      reverseJumps[line['jump-address']].push(line.address)
    }
    else if (line['internal-jump'] && !(line['jump-address'] in reverseJumps)) {
      reverseJumps[line['jump-address']] = [line.address]
    }
  }

  // load into assembly.contents
  assembly.contents = assembly.contents.map(function(line) {
    if (line['internal-jump']) {
      line['jumpTo'] = [line['jump-address']]; // arr to future-proof
    }
    if (line.address in reverseJumps) {
      line['jumpFrom'] = reverseJumps[line.address]
    }
    return line
  });

  // build array of { from: <addr>, to: <addr> }
  var jumps = [];
  assembly.contents.map(function(line) {
    var vert_offset = 12;
    if (line['internal-jump'] && document.getElementById(line['jump-address'])) {
      jumps.push({
        "from": line.address,
        "fromY": document.getElementById(line.address).offsetTop + vert_offset,
        "to": line['jump-address'],
        "toY": document.getElementById(line['jump-address']).offsetTop + vert_offset
      });
    }
  });

  // actually draw arrows
  var instructions = document.getElementsByClassName('instructions')[0];
  var svg_height = instructions.clientHeight;
  var svg_width = document.getElementsByClassName('jump-arrows')[0].clientWidth;
  
  svg.attr('height', svg_height);
  svg.append('svg:g')
    .attr('transform', function(jump, i) {
      return 'scale(-1, 1) translate(-' + svg_width + ', 0)';
    })
    .selectAll('path')
    .data(jumps)
    .enter().append('svg:path')
    .attr('d', function(jump, i) {
      var x = 5;
      var ext = (svg_width - x - 5) * (Math.abs(jump.fromY - jump.toY)/svg_height);
      ext = Math.max(5, ext);

      var command = "M" + x + " " + jump.fromY + " " +
        "h " + (x+ext) + " " +      // diff horizontally
        "V " + jump.toY + " " +     // vertical location
        "h " + (-(x+ext)) + " "     // diff horizontally
      return command;
    })
    .attr('marker-end', "url(#arrow)")
    .attr('opacity', 0.3)
    .attr('stroke', "gray");
    

    attachInstructionHandlers(jumps);
}

// highlight the mouseover-ed or clicked jump
function attachInstructionHandlers(jumps) {
  $(".row.instruction").on("mouseenter", function(event) {
    var instruc = event.currentTarget;
    highlightJumpArrows(jumps, instruc.id);
  });

  $(".row.instruction").on("click", function(event) {
    var instruc = event.currentTarget;
    assembly.active_instruction = event.currentTarget.id;
    highlightJumpArrows(jumps, instruc.id);
  });
}


function highlightJumpArrows(jumps, instruc_id) {
  var instr_active = assembly.active_instruction;

  // highlight if has jump
  svg.selectAll('g path')
    .data(jumps)
    .attr('opacity', function(jump, b) {
      if (jump['from'] == instr_active || jump['to'] == instr_active) {
        return 1;
      }
      else if (jump['from'] == instruc_id || jump['to'] == instruc_id) {
        return 1;
      }
      else {
        return 0.3;
      }
    })
    .attr('stroke', function(jump, b) {
      if (jump['from'] == instr_active || jump['to'] == instr_active) {
        return "rgb(3,169,244)";
      }
      if (jump['from'] == instruc_id || jump['to'] == instruc_id) {
        return "rgb(41,182,246)";
      }
      else {
        return "gray";
      }
    });
}

// wrap numbers for base changes etc.
function wrapAllNumbers() {
  $('.hljs-number').each(function(index, elem) {
    wrapNumbersInElem(elem);
  });
}

function wrapNumbersInElem(elem) {
  var charOne = elem.innerHTML.charAt(0);
  var charTwo = elem.innerHTML.charAt(1);
  if (charOne == '0' && charTwo == 'x') {
    // elem.className += ' hex';
    elem.setAttribute('value', 'hex');
  }
  else if (charOne >= '0' && charTwo <= '9') {
    elem.setAttribute('value', 'twosCompDec64');
  }
  else {
    console.log("Unknown data type:");
    console.log(elem);
  }
}

// wrap registers for register tracking
function wrapAllRegisters() {
  $(".instruction .op_str").each(function(index, el) {
    var instruc = assembly.contents[index];
    var instruc_regs = instruc.regs_write_explicit
      .concat(instruc.regs_write_implicit, instruc.regs_read_implicit, instruc.regs_read_explicit);
    
    // wrap normal registers and ptr registers
    var ops = el.getElementsByClassName('hljs-built_in');
    for (var i = 0; i < ops.length; i++) {
      // register
      if (instruc_regs.indexOf(ops[i].innerText) >= 0) {
        ops[i].classList.add("reg");
      }
      // ptr if it's not rip relative; also add the reg
      if (ops[i].innerText == 'ptr' && !textInHtmlCollection(ops, 'rip')) {
        ops[i].classList.add("reg");
        var reg = assembly.contents[index].ptr;
        ops[i].setAttribute('id', reg);
      }
    }
  });
}

function textInHtmlCollection(collection, text) {
  for (var i = 0; i < collection.length; i++) {
    if (collection[i].innerText == text) {
      return true;
    }
  }
  return false;
}

