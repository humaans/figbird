export function dom(): {
    root: any;
    render: (el: any) => void;
    unmount: () => void;
    click: (el: any) => void;
    flush: (fn: any) => Promise<void>;
    $: (sel: any) => any;
    $all: (sel: any) => any[];
    act: any;
};
export function queueTask(task: any): void;
export function service(name: any, details: any, options: any): Service;
export function mockFeathers(services: any): {
    service(name: any): any;
};
export function swallowErrors(yourTestFn: any): void;
declare class Service {
    constructor(name: any, data: any, options?: {});
    name: any;
    data: any;
    counts: {
        get: number;
        find: number;
        create: number;
        patch: number;
        update: number;
        remove: number;
    };
    delay: number;
    options: {};
    setDelay(delay: any): void;
    get(id: any): Promise<any>;
    find(params?: {}): Promise<{
        limit: any;
        skip: any;
        data: any[];
        total?: undefined;
    } | {
        total: number;
        limit: any;
        skip: any;
        data: any[];
    }>;
    create(data: any): Promise<any>;
    patch(id: any, data: any): Promise<any>;
    update(id: any, data: any): Promise<any>;
    remove(id: any): Promise<any>;
}
export {};
//# sourceMappingURL=helpers.d.ts.map