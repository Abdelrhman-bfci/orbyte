/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ISpringCrudContract {
	readonly entity: string;
	readonly packageName: string;
	readonly boilerplate: boolean;
}

export function getSpringCrudContract(instruction: string, referencePath: string, referenceCode: string): ISpringCrudContract | undefined {
	if (!/\b(?:create|add|implement)\b/i.test(instruction) || !/\b(?:crud|curd)\b/i.test(instruction) || !/controller\b/i.test(instruction)) {
		return undefined;
	}
	const entity = /\b[sS]ervice\s+[fF]or\s+([A-Z][A-Za-z0-9]*)\b/.exec(instruction)?.[1]
		?? /\b([A-Z][A-Za-z0-9]*)Service\b/.exec(instruction)?.[1];
	const packageName = /^\s*package\s+([\w.]+)\s*;/m.exec(referenceCode)?.[1];
	if (!entity || !packageName || !/\bimport\s+org\.springframework\.stereotype\.Service\s*;/.test(referenceCode) || !/@Service\b/.test(referenceCode)
		|| !/(?:^|\/)src\/main\/java\//.test(referencePath)) {
		return undefined;
	}
	const plainWords = /^(?:i|want|to|please|create|add|implement|a|the|new|service|controller|for|with|and|his|its|crud|curd|method|methods|operation|operations|logic)$/i;
	const boilerplate = /\b(?:List|Map)\s*<[^>]+>\s+\w+\s*=\s*new\s+(?:ArrayList|HashMap|LinkedHashMap|ConcurrentHashMap)\b/.test(referenceCode)
		&& /^[\w\s.,!?]+$/.test(instruction)
		&& (instruction.match(/\w+/g) ?? []).every(word => plainWords.test(word) || word === entity || word === `${entity}Service` || word === `${entity}Controller`);
	return { entity, packageName, boilerplate };
}

export function checkSpringCrudProposal(contract: ISpringCrudContract, files: ReadonlyMap<string, string>, existingTypes: ReadonlySet<string>): string[] {
	const { entity } = contract;
	const result: string[] = [];
	const service = files.get(`${entity}Service.java`);
	const controller = files.get(`${entity}Controller.java`);
	if (!service || !controller) {
		result.push(`Include complete ${entity}Service.java and ${entity}Controller.java classes in the proposal.`);
	}
	if (!files.has(`${entity}.java`) && !existingTypes.has(`${entity}.java`)) {
		result.push(`Include the ${entity}.java class referenced by the new service and controller. It does not exist in the workspace.`);
	}
	for (const type of [entity, `${entity}Service`, `${entity}Controller`]) {
		const declaration = files.get(`${type}.java`);
		if (declaration && (/^\s*package\s+([\w.]+)\s*;/m.exec(declaration)?.[1] !== contract.packageName || !new RegExp(`\\b(?:class|record)\\s+${type}\\b`).test(declaration))) {
			result.push(`${type}.java must declare ${type} in ${contract.packageName}.`);
		}
	}
	if (controller && !['Post', 'Get', 'Delete'].every(method => new RegExp(`@${method}Mapping\\b`).test(controller))) {
		result.push('The controller must expose create, read, and delete operations.');
	}
	if (controller && !/@(?:Put|Patch)Mapping\b/.test(controller)) {
		result.push('A CRUD proposal must include an update method and an @PutMapping or @PatchMapping endpoint.');
	}
	if (service && controller) {
		const field = new RegExp(`\\b${entity}Service\\s+(\\w+)\\s*;`).exec(controller)?.[1];
		for (const [, method] of service.matchAll(/\bvoid\s+(\w+)\s*\(/g)) {
			if (field && new RegExp(`\\breturn\\b[^;{}]*\\b${field}\\.${method}\\s*\\(`).test(controller)) {
				result.push(`The controller uses the result of ${entity}Service.${method}(), but the service method returns void.`);
			}
		}
	}
	return result;
}

export function createInMemorySpringCrudFiles({ entity, packageName }: ISpringCrudContract): ReadonlyMap<string, string> {
	const lowerName = entity.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
	const route = /[^aeiou]y$/.test(lowerName) ? `${lowerName.slice(0, -1)}ies` : /(?:s|sh|ch|x|z)$/.test(lowerName) ? `${lowerName}es` : `${lowerName}s`;
	return new Map([
		[`${entity}.java`, `package ${packageName};

public class ${entity} {
    private Long id;
    private String name;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }
}
`],
		[`${entity}Service.java`, `package ${packageName};

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.stereotype.Service;

@Service
public class ${entity}Service {
    private final Map<Long, ${entity}> records = new LinkedHashMap<>();
    private long nextId = 1;

    public synchronized ${entity} create(${entity} record) {
        record.setId(nextId++);
        records.put(record.getId(), record);
        return record;
    }

    public synchronized List<${entity}> findAll() {
        return new ArrayList<>(records.values());
    }

    public synchronized Optional<${entity}> find(Long id) {
        return Optional.ofNullable(records.get(id));
    }

    public synchronized Optional<${entity}> update(Long id, ${entity} record) {
        if (!records.containsKey(id)) {
            return Optional.empty();
        }
        record.setId(id);
        records.put(id, record);
        return Optional.of(record);
    }

    public synchronized boolean delete(Long id) {
        return records.remove(id) != null;
    }
}
`],
		[`${entity}Controller.java`, `package ${packageName};

import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/${route}")
public class ${entity}Controller {
    private final ${entity}Service service;

    public ${entity}Controller(${entity}Service service) {
        this.service = service;
    }

    @PostMapping
    public ResponseEntity<${entity}> create(@RequestBody ${entity} record) {
        return ResponseEntity.status(HttpStatus.CREATED).body(service.create(record));
    }

    @GetMapping
    public List<${entity}> findAll() {
        return service.findAll();
    }

    @GetMapping("/{id}")
    public ResponseEntity<${entity}> find(@PathVariable("id") Long id) {
        return service.find(id).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PutMapping("/{id}")
    public ResponseEntity<${entity}> update(@PathVariable("id") Long id, @RequestBody ${entity} record) {
        return service.update(id, record).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable("id") Long id) {
        return service.delete(id) ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }
}
`],
	]);
}
