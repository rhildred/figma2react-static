require('dotenv').config()
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const figma = require('./lib/figma');

const headers = new fetch.Headers();
const componentList = [];

let devToken = null;
let fileKey = null;  

try{
  devToken = process.env.DEV_TOKEN || process.argv[3];
  fileKey = process.env.FILE_KEY || process.argv[2];  
}catch{
  console.log('Usage: node main.js <file-key> [figma-dev-token]');
  process.exit(0);
}

headers.append('X-Figma-Token', devToken);
const baseUrl = 'https://api.figma.com';

const vectorMap = {};
const vectorList = [];
const vectorTypes = ['VECTOR', 'LINE', 'REGULAR_POLYGON', 'ELLIPSE', 'STAR'];

function preprocessTree(node) {
  let vectorsOnly = node.type !== 'FRAME';
  let vectorVConstraint = null;
  let vectorHConstraint = null;

  function paintsRequireRender(paints) {
    if (!paints) return false;

    let numPaints = 0;
    for (const paint of paints) {
      if (paint.visible === false) continue;

      numPaints++;
      if (paint.type === 'EMOJI') return true;
    }

    return numPaints > 1;
  }

  if (paintsRequireRender(node.fills) ||
      paintsRequireRender(node.strokes) ||
      (node.blendMode != null && ['PASS_THROUGH', 'NORMAL'].indexOf(node.blendMode) < 0)) {
    node.type = 'VECTOR';
  }

  const children = node.children && node.children.filter((child) => child.visible !== false);
  if (children) {
    for (let j=0; j<children.length; j++) {
      if (vectorTypes.indexOf(children[j].type) < 0) vectorsOnly = false;
      else {
        if (vectorVConstraint != null && children[j].constraints.vertical != vectorVConstraint) vectorsOnly = false;
        if (vectorHConstraint != null && children[j].constraints.horizontal != vectorHConstraint) vectorsOnly = false;
        vectorVConstraint = children[j].constraints.vertical;
        vectorHConstraint = children[j].constraints.horizontal;
      }
    }
  }
  node.children = children;

  if (children && children.length > 0 && vectorsOnly) {
    node.type = 'VECTOR';
    node.constraints = {
      vertical: vectorVConstraint,
      horizontal: vectorHConstraint,
    };
  }

  if (vectorTypes.indexOf(node.type) >= 0) {
    node.type = 'VECTOR';
    vectorMap[node.id] = node;
    vectorList.push(node.id);
    node.children = [];
  }

  if (node.children) {
    for (const child of node.children) {
      preprocessTree(child);
    }
  }
}

async function main() {
  let resp = await fetch(`${baseUrl}/v1/files/${fileKey}`, {headers});
  let data = await resp.json();
  fs.writeFileSync(`file_nodes.json`, JSON.stringify(data));
  const doc = data.document;
  const canvas = doc.children[0];
  const startNode = canvas.prototypeStartNodeID;
  let html = '';

  for (let i=0; i<canvas.children.length; i++) {
    const child = canvas.children[i]
    if (child.type === 'FRAME'  && child.visible !== false) {
      const child = canvas.children[i];
      preprocessTree(child);
    }else{
      fs.writeFileSync(`${child.name}_other_nodes.json`, JSON.stringify(child));
    }
  }

  data = await fetch(`${baseUrl}/v1/files/${fileKey}/images`, {headers});
  const imageJSON = await data.json();
  const imagesToSave = {};
  const images = imageJSON.meta.images || {};
  if (images) {
    let promises = [];
    let guids = [];
    for (const guid in images) {
      if (images[guid] == null) continue;
      imagesToSave[guid] = {url: images[guid]};
      guids.push(guid);
      promises.push(fetch(images[guid]));
    }

    let responses = await Promise.all(promises);
    promises = [];
    for (let i = 0; i < responses.length; i++) {
      imagesToSave[guids[i]].contentType = responses[i].headers.get("Content-Type");
      promises.push(responses[i].buffer());
    }

    responses = await Promise.all(promises);
    for (let i=0; i<responses.length; i++) {
      imagesToSave[guids[i]].body = responses[i];
    }
  }

  const componentMap = {};
  let contents = `
import React, { PureComponent } from 'react';
import { Link, Router } from 'components/Router'\n`;
  let nextSection = '';

  for (let i=0; i<canvas.children.length; i++) {
    const child = canvas.children[i]
    if (child.type === 'FRAME' && child.visible !== false) {
      const sName = child.name.replace(/\W+/g, "");
      const sNodeIds = figma.getNodeIds(child);
      console.log(`${child.name}:${sNodeIds}`);
      data = await fetch(`${baseUrl}/v1/files/${fileKey}/nodes?ids=${sNodeIds}`, {headers});
      const nodeJSON = await data.json();
      fs.writeFileSync(`${sName}_nodes.json`, JSON.stringify(nodeJSON));
      let sFileName = sName.toLowerCase();
      if(child.id == startNode){
        // TODO set filename to src/pages/index.js
        sFileName = "index";
        componentMap.index = child.name
      }
      figma.createComponent(child, imagesToSave, componentMap);
      let sPageFile = `import React, { PureComponent } from 'react';\n`;
      sPageFile += `import { C${sName} } from '../components/C${sName}';\n`;

      sPageFile += `export default class Master${sName} extends PureComponent {\n`;
      sPageFile += "  render() {\n";
      sPageFile += `    return <div className="master" style={{backgroundColor: "${figma.colorString(child.backgroundColor)}"}}>\n`;
      sPageFile += `      <C${sName} {...this.props} nodeId="${child.id}" />\n`;
      sPageFile += "    </div>\n";
      sPageFile += "  }\n";
      sPageFile += "}\n\n";
      fs.writeFileSync(`src/pages/${sFileName}.js`, sPageFile);
    }
  }

  const imported = {};
  for (const key in componentMap) {
    if(key == "index") continue;
    const component = componentMap[key];
    const name = component.name;
    if (!imported[name]) {
      contents += `import { ${name} } from './components/${name}';\n`;
    }
    imported[name] = true;
  }
  contents += "\n";
  contents += nextSection;
  nextSection = '';

  contents += `export function getComponentFromId(id) {\n`;

  for (const key in componentMap) {
    contents += `  if (id === "${key}") return ${componentMap[key].instance};\n`;
    nextSection += componentMap[key].doc + "\n";
  }

  contents += "  return null;\n}\n\n";
  contents += nextSection;

  const sPath = "./src/figmaComponents.js";
  const sFolder = path.dirname(sPath);
  if(!fs.existsSync(sFolder)){
    fs.mkdirSync(sFolder, { recursive: true });
  }
  fs.writeFile(sPath, contents, function(err) {
    if (err) console.log(err);
    console.log(`wrote ${sPath}`);
  });
}

main().catch((err) => {
  console.error(err);
  console.error(err.stack);
});
