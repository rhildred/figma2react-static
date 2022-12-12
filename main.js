require('dotenv').config()
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const figma = require('./lib/figma');

const headers = new fetch.Headers();
const componentList = [];
let devToken = process.env.DEV_TOKEN;

if (process.argv.length < 3) {
  console.log('Usage: node setup.js <file-key> [figma-dev-token]');
  process.exit(0);
}

if (process.argv.length > 3) {
  devToken = process.argv[3];
}

headers.append('X-Figma-Token', devToken);

const fileKey = process.argv[2];
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

  const doc = data.document;
  const canvas = doc.children[0];
  const startNode = canvas.prototypeStartNodeID;
  let html = '';

  for (let i=0; i<canvas.children.length; i++) {
    const child = canvas.children[i]
    if (child.type === 'FRAME'  && child.visible !== false) {
      const child = canvas.children[i];
      preprocessTree(child);
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
  let contents = `import React, { PureComponent } from 'react';\n`;
  let nextSection = '';

  for (let i=0; i<canvas.children.length; i++) {
    const child = canvas.children[i]
    if (child.type === 'FRAME' && child.visible !== false) {
      const child = canvas.children[i];
      figma.createComponent(child, imagesToSave, componentMap);
      nextSection += `export class Master${child.name.replace(/\W+/g, "")} extends PureComponent {\n`;
      nextSection += "  render() {\n";
      nextSection += `    return <div className="master" style={{backgroundColor: "${figma.colorString(child.backgroundColor)}"}}>\n`;
      nextSection += `      <C${child.name.replace(/\W+/g, "")} {...this.props} nodeId="${child.id}" />\n`;
      nextSection += "    </div>\n";
      nextSection += "  }\n";
      nextSection += "}\n\n";
      if(child.id == startNode){
        // TODO set filename to src/pages/index.js
      }
    }
  }

  const imported = {};
  for (const key in componentMap) {
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
