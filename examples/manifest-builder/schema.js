// Auto-generated from schema.json — do not hand-edit.
// Regenerate by running build-vendor.sh.
export default {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://otzi.example/schemas/headless-manifest-v1.json",
  "title": "headless-manifest-v1",
  "type": "object",
  "required": [
    "version",
    "name",
    "contracts"
  ],
  "additionalProperties": false,
  "properties": {
    "version": {
      "type": "integer",
      "const": 1
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "description": {
      "type": "string",
      "maxLength": 2000
    },
    "contracts": {
      "type": "array",
      "minItems": 1,
      "items": {
        "$ref": "#/$defs/Contract"
      }
    }
  },
  "$defs": {
    "Contract": {
      "type": "object",
      "required": [
        "name",
        "address",
        "type"
      ],
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,63}$"
        },
        "address": {
          "type": "string",
          "pattern": "^0x[0-9a-fA-F]{64}$"
        },
        "type": {
          "type": "string",
          "enum": [
            "OP20",
            "OP20S",
            "OP721",
            "Custom"
          ]
        },
        "decimals": {
          "type": "integer",
          "minimum": 0,
          "maximum": 38
        },
        "abi": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Method"
          }
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "type": {
                "enum": [
                  "OP20",
                  "OP20S"
                ]
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "required": [
              "decimals"
            ],
            "not": {
              "required": [
                "abi"
              ]
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "OP721"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "not": {
              "required": [
                "abi"
              ]
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "Custom"
              }
            },
            "required": [
              "type"
            ]
          },
          "then": {
            "required": [
              "abi"
            ]
          }
        }
      ]
    },
    "Method": {
      "type": "object",
      "required": [
        "name",
        "params"
      ],
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"
        },
        "params": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/Param"
          }
        }
      }
    },
    "Param": {
      "type": "object",
      "required": [
        "name",
        "type"
      ],
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"
        },
        "type": {
          "type": "string",
          "enum": [
            "address",
            "bool",
            "string",
            "bytes",
            "uint8",
            "uint16",
            "uint32",
            "uint64",
            "uint128",
            "uint256"
          ]
        }
      }
    }
  }
};
